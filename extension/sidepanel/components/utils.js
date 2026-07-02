/**
 * Utility functions for common operations
 */

const Clipboard = {
  /**
   * Copy text to clipboard with fallback for older browsers
   * @param {string} text - Text to copy
   * @param {string} successMsg - Success message to show
   * @returns {Promise<boolean>}
   */
  async copy(text, successMsg = 'Copied to clipboard') {
    try {
      // Modern clipboard API
      await navigator.clipboard.writeText(text);
      Toast.show(successMsg, 'success');
      return true;
    } catch (e) {
      // Fallback for older browsers
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (success) {
          Toast.show(successMsg, 'success');
          return true;
        }
      } catch (fallbackError) {
        console.error('Clipboard copy failed:', fallbackError);
      }
      Toast.show('Failed to copy to clipboard', 'error');
      return false;
    }
  }
};

const Exporter = {
  /**
   * Export data to CSV file
   * @param {Array<Object>} data - Array of objects to export
   * @param {string} filename - Filename without extension
   * @param {Array<string>} columns - Column headers
   */
  toCSV(data, filename, columns) {
    if (!data || !data.length) {
      Toast.show('No data to export', 'warning');
      return;
    }

    // Create CSV content
    const headers = columns.join(',');
    const rows = data.map(row =>
      columns.map(col => {
        const value = row[col] || '';
        // Escape values containing commas or quotes
        if (value.toString().includes(',') || value.toString().includes('"')) {
          return `"${value.toString().replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    );

    const csv = [headers, ...rows].join('\n');

    // Create and download file
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    Toast.show(`Exported ${data.length} items to ${link.download}`, 'success');
  },

  /**
   * Export data to JSON file
   * @param {any} data - Data to export
   * @param {string} filename - Filename without extension
   */
  toJSON(data, filename) {
    if (!data) {
      Toast.show('No data to export', 'warning');
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().split('T')[0]}.json`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    Toast.show(`Exported to ${link.download}`, 'success');
  }
};

const ButtonLoader = {
  /**
   * Show loading state on a button
   * @param {HTMLButtonElement} button - Button element
   * @param {string} loadingText - Text to show while loading
   * @returns {Function} Restore function to call when done
   */
  start(button, loadingText = 'Loading...') {
    const originalHTML = button.innerHTML;
    const originalDisabled = button.disabled;

    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span>${loadingText}`;

    return () => {
      button.innerHTML = originalHTML;
      button.disabled = originalDisabled;
    };
  }
};

const HTMLEscape = {
  /**
   * Escape HTML to prevent XSS
   * @param {string} unsafe - Unsafe string
   * @returns {string} Escaped string
   */
  escape(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

const Bookmarks = {
  STORAGE_KEY: 'apim-bookmarks',

  /**
   * Get all bookmarks
   * @returns {Array<Object>} Array of bookmarked APIs
   */
  getAll() {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Failed to load bookmarks:', e);
      return [];
    }
  },

  /**
   * Check if an API is bookmarked
   * @param {string} apiId - API ID
   * @param {string} env - Environment
   * @returns {boolean}
   */
  isBookmarked(apiId, env) {
    const bookmarks = this.getAll();
    return bookmarks.some(b => b.id === apiId && b.env === env);
  },

  /**
   * Add a bookmark
   * @param {Object} api - API object
   * @param {string} env - Environment
   * @returns {boolean} Success
   */
  add(api, env) {
    try {
      const bookmarks = this.getAll();

      // Check if already bookmarked
      if (this.isBookmarked(api.id, env)) {
        return false;
      }

      // Add bookmark
      bookmarks.push({
        id: api.id,
        displayName: api.displayName,
        path: api.path,
        revision: api.revision,
        versionName: api.versionName || '',
        env,
        addedAt: Date.now()
      });

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(bookmarks));
      Toast.show(`Bookmarked: ${api.displayName}`, 'success');
      return true;
    } catch (e) {
      console.error('Failed to add bookmark:', e);
      Toast.show('Failed to add bookmark', 'error');
      return false;
    }
  },

  /**
   * Remove a bookmark
   * @param {string} apiId - API ID
   * @param {string} env - Environment
   * @returns {boolean} Success
   */
  remove(apiId, env) {
    try {
      let bookmarks = this.getAll();
      const initialLength = bookmarks.length;

      bookmarks = bookmarks.filter(b => !(b.id === apiId && b.env === env));

      if (bookmarks.length === initialLength) {
        return false; // Not found
      }

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(bookmarks));
      Toast.show('Bookmark removed', 'info');
      return true;
    } catch (e) {
      console.error('Failed to remove bookmark:', e);
      Toast.show('Failed to remove bookmark', 'error');
      return false;
    }
  },

  /**
   * Toggle bookmark
   * @param {Object} api - API object
   * @param {string} env - Environment
   * @returns {boolean} New bookmark state (true = bookmarked)
   */
  toggle(api, env) {
    if (this.isBookmarked(api.id, env)) {
      this.remove(api.id, env);
      return false;
    } else {
      this.add(api, env);
      return true;
    }
  },

  /**
   * Clear all bookmarks
   */
  clear() {
    localStorage.removeItem(this.STORAGE_KEY);
    Toast.show('All bookmarks cleared', 'info');
  }
};
