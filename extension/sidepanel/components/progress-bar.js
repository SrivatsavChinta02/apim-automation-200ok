const ProgressBar = {
  create(container, totalSteps) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mb-3';
    wrapper.innerHTML = `
      <div class="progress mb-2" style="height: 6px;">
        <div class="progress-bar bg-primary progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%"></div>
      </div>
      <div class="steps-list"></div>`;
    container.appendChild(wrapper);
    const bar = wrapper.querySelector('.progress-bar');
    const list = wrapper.querySelector('.steps-list');
    const steps = [];

    return {
      update(step, message, status) {
        const pct = Math.round((step / totalSteps) * 100);
        bar.style.width = pct + '%';

        // Only turn bar red on error; keep animated blue during progress
        if (status === 'error') {
          bar.className = 'progress-bar bg-danger';
        }

        if (!steps[step - 1]) {
          const row = document.createElement('div');
          row.className = 'd-flex align-items-center gap-2 py-1';
          row.style.fontSize = '.82rem';
          list.appendChild(row);
          steps[step - 1] = row;
        }
        const icons = { running: 'bi-arrow-repeat text-primary', done: 'bi-check-circle-fill text-success', error: 'bi-x-circle-fill text-danger' };
        steps[step - 1].innerHTML = `<i class="bi ${icons[status] || icons.running}"></i><span>${message}</span>`;
      },
      complete(message) {
        bar.style.width = '100%';
        bar.className = 'progress-bar bg-success';
        const row = document.createElement('div');
        row.className = 'alert alert-success mt-2 py-2 px-3';
        row.style.fontSize = '.82rem';
        row.innerHTML = `<i class="bi bi-check-circle me-1"></i>${message}`;
        list.appendChild(row);
      },
      error(message) {
        bar.className = 'progress-bar bg-danger';
        const row = document.createElement('div');
        row.className = 'alert alert-danger mt-2 py-2 px-3';
        row.style.fontSize = '.82rem';
        row.innerHTML = `<i class="bi bi-x-circle me-1"></i>${message}`;
        list.appendChild(row);
      }
    };
  }
};
