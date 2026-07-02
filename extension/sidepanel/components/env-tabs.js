const EnvTabs = {
  render(container, activeEnv, onChange, disabledEnv = null) {
    const envs = [
      { key: 'dev',     label: 'Dev' },
      { key: 'sandbox', label: 'Sandbox' },
      { key: 'prod',    label: 'Prod' },
      { key: 'dr',      label: 'DR' },
    ];
    const nav = document.createElement('div');
    nav.className = 'env-tabs d-flex gap-1 mb-2';
    envs.forEach(env => {
      const btn = document.createElement('button');
      const isActive = env.key === activeEnv;
      const isDisabled = env.key === disabledEnv;
      btn.className = 'btn btn-sm' + (isActive ? ' btn-primary active' : ' btn-outline-secondary');
      btn.textContent = env.label;
      if (isDisabled) {
        btn.disabled = true;
        btn.title = 'Same as source environment';
        btn.style.opacity = '.45';
        btn.style.cursor = 'not-allowed';
      }
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        nav.querySelectorAll('.btn').forEach(b => {
          b.className = 'btn btn-sm btn-outline-secondary';
        });
        btn.className = 'btn btn-sm btn-primary active';
        onChange(env.key);
      });
      nav.appendChild(btn);
    });
    container.appendChild(nav);
    return nav;
  }
};
