const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable size using binary multiples (1 KB = 1024 B). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1')} ${UNITS[unit]}`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

/**
 * Describes the size difference between an original and a result.
 * `percent` is negative when the result is smaller.
 */
export function describeSizeChange(originalBytes, resultBytes) {
  const delta = resultBytes - originalBytes;
  const percent = originalBytes > 0 ? (delta / originalBytes) * 100 : 0;
  let direction = 'same';
  if (delta < 0) direction = 'smaller';
  else if (delta > 0) direction = 'larger';
  return {
    delta,
    absoluteDelta: Math.abs(delta),
    percent,
    direction,
    label: formatPercent(percent),
  };
}

export function formatPercent(percent) {
  const rounded = Math.abs(percent) < 0.1 && percent !== 0 ? (percent < 0 ? -0.1 : 0.1) : percent;
  const text = Math.abs(rounded).toFixed(Math.abs(rounded) >= 10 ? 0 : 1);
  if (rounded === 0) return '0%';
  return `${rounded < 0 ? '−' : '+'}${text}%`;
}
