(function () {
  const instances = new WeakMap();

  function valueAt(path, source, fallback) {
    return path.reduce((current, key) => current && current[key], source) ?? fallback;
  }

  class ChartLite {
    constructor(context, config) {
      this.ctx = context;
      this.canvas = context.canvas;
      this.data = config.data || { labels: [], datasets: [] };
      this.options = config.options || {};
      this.plugins = config.plugins || [];
      instances.set(this.canvas, this);
      this.update();
    }

    static getChart(canvas) {
      return instances.get(canvas);
    }

    getDatasetMeta(index) {
      return { data: this._points?.[index] || [] };
    }

    update() {
      this._draw();
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(320, Math.floor(rect.width || this.canvas.clientWidth || 640));
      const height = Math.max(180, Math.floor(rect.height || this.canvas.clientHeight || 260));

      if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
        this.canvas.width = width * ratio;
        this.canvas.height = height * ratio;
      }

      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { width, height };
    }

    _draw() {
      const { width, height } = this._resize();
      const ctx = this.ctx;
      const labels = this.data.labels || [];
      const datasets = this.data.datasets || [];
      const values = datasets.flatMap((dataset) => dataset.data || []);
      const configuredMax = valueAt(['scales', 'y', 'max'], this.options, null)
        || valueAt(['scales', 'y', 'suggestedMax'], this.options, null);
      const maxValue = Math.max(5, Number(configuredMax) || 0, ...values.map(Number));
      const padding = { top: 20, right: 18, bottom: 46, left: 34 };
      const plotWidth = Math.max(1, width - padding.left - padding.right);
      const plotHeight = Math.max(1, height - padding.top - padding.bottom);
      const count = Math.max(1, labels.length);
      const xFor = (index) => padding.left + (count === 1 ? plotWidth / 2 : (plotWidth * index) / (count - 1));
      const yFor = (value) => padding.top + plotHeight - (Math.max(0, Number(value) || 0) / maxValue) * plotHeight;

      this._points = datasets.map(() => []);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = '#e5eaf1';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#647189';
      ctx.font = '600 8px Inter, Arial, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const steps = 5;
      for (let step = 0; step <= steps; step += 1) {
        const value = Math.round((maxValue / steps) * step);
        const y = yFor(value);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.fillText(String(value), padding.left - 8, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      labels.forEach((label, index) => {
        ctx.fillText(String(label), xFor(index), height - padding.bottom + 14);
      });

      datasets.forEach((dataset, datasetIndex) => {
        const data = dataset.data || [];
        if (dataset.type === 'line') {
          ctx.strokeStyle = dataset.borderColor || '#1f7ae0';
          ctx.lineWidth = dataset.borderWidth || 2;
          ctx.beginPath();
          data.forEach((value, index) => {
            const point = { x: xFor(index), y: yFor(value) };
            this._points[datasetIndex][index] = point;
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          });
          ctx.stroke();

          data.forEach((value, index) => {
            const point = this._points[datasetIndex][index];
            ctx.beginPath();
            ctx.fillStyle = dataset.pointBackgroundColor || '#ffffff';
            ctx.strokeStyle = dataset.pointBorderColor || dataset.borderColor || '#1f7ae0';
            ctx.lineWidth = dataset.pointBorderWidth || 2;
            ctx.arc(point.x, point.y, dataset.pointRadius || 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          });
          return;
        }

        const barWidth = Math.min(dataset.barThickness || 22, plotWidth / count * 0.46);
        ctx.fillStyle = dataset.backgroundColor || '#0f9975';
        data.forEach((value, index) => {
          const x = xFor(index) - barWidth / 2;
          const y = yFor(value);
          const barHeight = padding.top + plotHeight - y;
          this._points[datasetIndex][index] = { x: x + barWidth / 2, y };
          ctx.fillRect(x, y, barWidth, Math.max(1, barHeight));
        });
      });

      this.plugins.forEach((plugin) => {
        if (typeof plugin.afterDatasetsDraw === 'function') plugin.afterDatasetsDraw(this);
      });
    }
  }

  window.Chart = ChartLite;
}());
