const SearchInput = {
  create(container, { placeholder = 'Search...', onSearch, onSelect }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'position-relative mb-3';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    wrapper.appendChild(input);

    const dropdown = document.createElement('div');
    dropdown.className = 'list-group';
    dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:9999;max-height:220px;overflow-y:auto;display:none;background:#fff;border:1px solid #dee2e6;border-top:0;border-radius:0 0 .375rem .375rem;box-shadow:0 4px 12px rgba(0,0,0,.15)';
    wrapper.appendChild(dropdown);

    container.appendChild(wrapper);

    let debounce = null;
    let lastResults = [];

    function show() { dropdown.style.display = 'block'; }
    function hide() { dropdown.style.display = 'none'; }

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 2) { hide(); lastResults = []; return; }

      // Show loading indicator immediately
      dropdown.innerHTML = '<div class="list-group-item text-muted py-1" style="font-size:.8rem"><i class="bi bi-hourglass-split me-1"></i>Searching...</div>';
      show();

      debounce = setTimeout(async () => {
        try {
          const results = await onSearch(q);
          lastResults = results;
          if (!results || !results.length) {
            dropdown.innerHTML = '<div class="list-group-item text-muted py-1" style="font-size:.8rem">No results found</div>';
            show();
            return;
          }
          dropdown.innerHTML = '';
          results.forEach((r, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'list-group-item list-group-item-action py-1 px-2';
            btn.style.cssText = 'font-size:.82rem;cursor:pointer;border-left:0;border-right:0';
            btn.textContent = r.label || r.displayName || r.id;
            btn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              input.value = r.label || r.displayName;
              hide();
              onSelect(r);
            });
            dropdown.appendChild(btn);
          });
          show();
        } catch (err) {
          dropdown.innerHTML = `<div class="list-group-item text-danger py-1" style="font-size:.8rem"><i class="bi bi-exclamation-triangle me-1"></i>${err.message || 'Search failed'}</div>`;
          show();
        }
      }, 300);
    });

    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && dropdown.children.length > 0) show();
    });

    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) hide();
    });

    return { input, clear() { input.value = ''; hide(); lastResults = []; } };
  }
};
