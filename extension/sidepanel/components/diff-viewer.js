const DiffViewer = {

  // Promote tab: directional side-by-side
  // add = will be added to dest (green on left)
  // remove = will be removed from dest (red on right)
  renderFromDiff(container, diffLines, leftLabel = 'Source', rightLabel = 'Destination') {
    if (!diffLines || !diffLines.length) return;
    const { leftPre, rightPre } = this._makePanels(container, leftLabel, rightLabel);
    diffLines.forEach(({ line, type }) => {
      const lDiv = document.createElement('div');
      const rDiv = document.createElement('div');
      if (type === 'context') {
        lDiv.textContent = '  ' + line;
        rDiv.textContent = '  ' + line;
      } else if (type === 'add') {
        lDiv.textContent = '+ ' + line;
        lDiv.style.cssText = 'background:#d1fae5;color:#166534;';
        rDiv.textContent = '\u00a0';
        rDiv.style.cssText = 'background:#f0fdf4;';
      } else if (type === 'remove') {
        lDiv.textContent = '\u00a0';
        lDiv.style.cssText = 'background:#fff5f5;';
        rDiv.textContent = '− ' + line;
        rDiv.style.cssText = 'background:#fee2e2;color:#991b1b;';
      }
      leftPre.appendChild(lDiv);
      rightPre.appendChild(rDiv);
    });
    this._syncScroll(leftPre, rightPre);
  },

  // Diff tab: neutral side-by-side
  // left_only = green on left, right_only = green on right, changed = yellow both
  renderAligned(container, alignedLines, leftLabel = 'Env 1', rightLabel = 'Env 2') {
    if (!alignedLines || !alignedLines.length) return;
    const { leftPre, rightPre } = this._makePanels(container, leftLabel, rightLabel);
    alignedLines.forEach(({ left, right, type }) => {
      const lDiv = document.createElement('div');
      const rDiv = document.createElement('div');
      if (type === 'context') {
        lDiv.textContent = '  ' + left;
        rDiv.textContent = '  ' + right;
      } else if (type === 'left_only') {
        lDiv.textContent = '+ ' + left;
        lDiv.style.cssText = 'background:#d1fae5;color:#166534;';
        rDiv.textContent = '\u00a0';
        rDiv.style.cssText = 'background:#f0fdf4;';
      } else if (type === 'right_only') {
        lDiv.textContent = '\u00a0';
        lDiv.style.cssText = 'background:#f0fdf4;';
        rDiv.textContent = '+ ' + right;
        rDiv.style.cssText = 'background:#d1fae5;color:#166534;';
      } else if (type === 'changed') {
        lDiv.textContent = '~ ' + left;
        lDiv.style.cssText = 'background:#fef3c7;color:#92400e;';
        rDiv.textContent = '~ ' + right;
        rDiv.style.cssText = 'background:#fef3c7;color:#92400e;';
      }
      leftPre.appendChild(lDiv);
      rightPre.appendChild(rDiv);
    });
    this._syncScroll(leftPre, rightPre);
  },

  render(container, { left, right, leftLabel = 'Source', rightLabel = 'Destination' }) {
    const { leftPre, rightPre } = this._makePanels(container, leftLabel, rightLabel);
    const leftLines = (left || '').split('\n');
    const rightLines = (right || '').split('\n');
    const maxLen = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < maxLen; i++) {
      const lLine = leftLines[i] ?? '';
      const rLine = rightLines[i] ?? '';
      const lSpan = document.createElement('div');
      const rSpan = document.createElement('div');
      lSpan.textContent = lLine || '\u00a0';
      rSpan.textContent = rLine || '\u00a0';
      if (!lLine && rLine) { rSpan.style.cssText = 'background:#d1fae5;color:#166534;'; }
      else if (lLine && !rLine) { lSpan.style.cssText = 'background:#fee2e2;color:#991b1b;'; }
      else if (lLine !== rLine) { lSpan.style.cssText = 'background:#fef3c7;'; rSpan.style.cssText = 'background:#fef3c7;'; }
      leftPre.appendChild(lSpan);
      rightPre.appendChild(rSpan);
    }
    this._syncScroll(leftPre, rightPre);
  },

  _makePanels(container, leftLabel, rightLabel) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';
    const makePanel = (label) => {
      const panel = document.createElement('div');
      panel.style.cssText = 'border:1px solid #e5e7eb;border-radius:4px;overflow:hidden;min-width:0;';
      const header = document.createElement('div');
      header.style.cssText = 'background:linear-gradient(135deg,#1d4ed8,#2563eb);color:white;font-size:.72rem;font-weight:600;padding:3px 8px;';
      header.textContent = label;
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-size:.71rem;max-height:250px;overflow-y:auto;overflow-x:auto;margin:0;padding:4px;background:#fafafa;white-space:pre;';
      panel.appendChild(header);
      panel.appendChild(pre);
      return { panel, pre };
    };
    const { panel: lPanel, pre: leftPre } = makePanel(leftLabel);
    const { panel: rPanel, pre: rightPre } = makePanel(rightLabel);
    wrapper.appendChild(lPanel);
    wrapper.appendChild(rPanel);
    container.appendChild(wrapper);
    return { leftPre, rightPre };
  },

  _syncScroll(leftPre, rightPre) {
    leftPre.addEventListener('scroll', () => { rightPre.scrollTop = leftPre.scrollTop; rightPre.scrollLeft = leftPre.scrollLeft; });
    rightPre.addEventListener('scroll', () => { leftPre.scrollTop = rightPre.scrollTop; leftPre.scrollLeft = rightPre.scrollLeft; });
  }
};