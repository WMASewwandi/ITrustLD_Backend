function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRemoteBufferOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Race remotes so a hanging Laravel URL cannot block S3. Retry once if all fail. */
export async function fetchFirstRemoteBuffer(urls, { timeoutMs = 5000, attempts = 2 } = {}) {
  const candidates = [...new Set((urls || []).filter(Boolean))];
  if (!candidates.length) return null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const results = await Promise.allSettled(
      candidates.map((url) => fetchRemoteBufferOnce(url, timeoutMs)),
    );
    const buffer = results.find((result) => result.status === 'fulfilled' && result.value)?.value;
    if (buffer) return buffer;
    if (attempt < attempts - 1) await wait(200 * (attempt + 1));
  }

  return null;
}
