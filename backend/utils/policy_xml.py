import re


def fix_entities(xml: str) -> str:
    xml = xml.replace("&amp;quot;", "&quot;")
    xml = xml.replace("&#xA;", "\n")
    return xml


def extract_backend_ids(xml: str) -> list[str]:
    return re.findall(r'backend-id="([^"]+)"', xml)


def extract_named_values(xml: str) -> list[str]:
    return re.findall(r'\{\{([^}]+)\}\}', xml)


def extract_base_urls(xml: str) -> list[str]:
    """Find every base-url="..." attribute value in policy XML."""
    return re.findall(r'base-url="([^"]+)"', xml or "")


def ensure_consumer_name_variable(api_xml: str) -> str:
    """Ensure the API-level policy extracts the consumer-name header into a context var.

    Idempotent. If the set-variable line is already present (matched loosely
    by name="consumer-name"), returns xml unchanged. Otherwise inserts it
    immediately after the first `<base />` in the `<inbound>` section.

    The op-level <choose> blocks rely on this variable being set; without it
    they evaluate against an empty string and reject every caller with 401.
    """
    if not api_xml:
        return api_xml
    # Loose check covering both raw and entity-escaped attribute forms
    if 'name="consumer-name"' in api_xml or 'name=&quot;consumer-name&quot;' in api_xml:
        return api_xml
    insert = ('    <set-variable name="consumer-name" '
              'value=\'@(context.Request.Headers.GetValueOrDefault("consumer-name", "").ToLowerInvariant())\' />')
    # Insert after the FIRST <base /> inside <inbound>. We don't risk affecting
    # <backend>/<outbound>/<on-error> because we use re.sub with count=1.
    return re.sub(r'(<inbound>\s*<base\s*/>)', r'\1\n' + insert, api_xml, count=1)


def inject_consumer_name(xml: str, name: str) -> str:
    """Add or update a consumer-name allowlist <choose> block in op-level policy XML.

    Idempotent. Detects the existing block whether the XML uses `&quot;` entity
    encoding OR raw double-quotes (APIM returns either depending on format).

    ``name`` may be a single name or comma-separated list. Every entry is
    lowercased before injection.
    """
    new_names = [n.strip().lower() for n in name.split(',') if n.strip()]
    if not new_names:
        return xml

    raw_marker = 'context.Variables["consumer-name"]'
    entity_marker = 'context.Variables[&quot;consumer-name&quot;]'

    if raw_marker in xml or entity_marker in xml:
        array_pat = re.compile(
            r'new\[\]\s*\{([^}]*)\}\s*\.Contains\(\(string\)context\.Variables\[(?:&quot;|")consumer-name(?:&quot;|")\]\)',
            re.DOTALL,
        )
        m = array_pat.search(xml)
        if m:
            existing_raw = m.group(1)
            existing_names = re.findall(r'(?:&quot;|")([^&"]+?)(?:&quot;|")', existing_raw)
            merged = list(existing_names)
            for n in new_names:
                if n not in merged:
                    merged.append(n)
            # Always emit raw " for new content (cleaner). The outer attribute
            # is single-quoted so APIM accepts it. We preserve the existing
            # block's structure but normalise quoting style on rewrite.
            names_array = ', '.join([f'"{n}"' for n in merged])
            new_condition = (
                f'new[] {{ {names_array} }}'
                f'.Contains((string)context.Variables["consumer-name"])'
            )
            return xml[:m.start()] + new_condition + xml[m.end():]

    # No existing block — insert after first <base /> in <inbound>.
    # Use single-quoted outer attribute so inner array literals can use raw ".
    names_array = ', '.join([f'"{n}"' for n in new_names])
    insert_xml = f'''    <choose>
        <when condition='@(new[] {{ {names_array} }}.Contains((string)context.Variables["consumer-name"]))' />
        <otherwise>
            <return-response>
                <set-status code="401" reason="Unauthorized" />
                <set-header name="Content-Type" exists-action="override">
                    <value>application/json</value>
                </set-header>
                <set-body>{{"error":"This consumer doesn't have permission to execute the operation!"}}</set-body>
            </return-response>
        </otherwise>
    </choose>'''
    return re.sub(r'(<base\s*/>)', r'\1\n' + insert_xml, xml, count=1)


def inject_appid(xml: str, client_id: str) -> str:
    # If check-header for appid exists, append new value element
    pattern = r'(<check-header[^>]*name="appid"[^>]*>)(.*?)(</check-header>)'
    match = re.search(pattern, xml, re.DOTALL)
    if match:
        inner = match.group(2)
        new_value = f'\n      <value>{client_id}</value>'
        new_inner = inner.rstrip() + new_value + '\n    '
        return xml[:match.start(2)] + new_inner + xml[match.end(2):]
    # No existing check-header — insert after <base /> in inbound
    insert_xml = f'''    <check-header name="appid" failed-check-httpcode="403" failed-check-error-message="Forbidden">
      <value>{client_id}</value>
    </check-header>'''
    return re.sub(r'(<base\s*/>)', r'\1\n' + insert_xml, xml, count=1)
