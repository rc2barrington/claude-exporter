// Chrome messages have a size ceiling. Send independently acknowledged records
// in small pieces, with no ceiling on the total conversation or attachment size.
globalThis.AIChatExporterTransport = (() => {
  const CHUNK_CHARS = 256 * 1024;
  const arrays = ["messages", "savedMedia", "remoteQueue", "failedFetches"];
  async function send(data, transferId, request, check = () => {}) {
    const call = async payload => {
      check();
      const result = await request({ action: "exportTransfer", transferId, ...payload });
      check();
      if (!result || result.status !== "ok") throw new Error(result?.error || "Export transfer was interrupted.");
    };
    await call({ operation: "begin" });
    try {
      const meta = Object.fromEntries(Object.entries(data).filter(([key]) => !arrays.includes(key)));
      async function record(field, value) {
        const json = JSON.stringify(value);
        let sequence = 0;
        for (let offset = 0; offset < json.length; offset += CHUNK_CHARS) {
          await call({ operation: "chunk", field, sequence: sequence++, chunk: json.slice(offset, offset + CHUNK_CHARS), last: offset + CHUNK_CHARS >= json.length });
        }
      }
      await record("meta", meta);
      for (const field of arrays) for (const entry of data[field] || []) await record(field, entry);
      await call({ operation: "finish" });
      return { transferId, messageCount: data.messageCount };
    } catch (error) {
      await request({ action: "exportTransfer", transferId, operation: "discard" }).catch(() => {});
      throw error;
    }
  }
  function receiver() {
    const transfers = new Map();
    function receive(message) {
      const { transferId, operation, field, sequence, chunk, last } = message;
      if (typeof transferId !== "string" || !transferId) throw new Error("Missing transfer identifier.");
      if (operation === "begin") {
        transfers.clear();
        transfers.set(transferId, { data: { messages: [], savedMedia: [], remoteQueue: [], failedFetches: [] }, parts: [], sequence: 0, field: null, complete: false });
        return;
      }
      if (operation === "discard") { transfers.delete(transferId); return; }
      const state = transfers.get(transferId);
      if (!state || state.complete) throw new Error("Unknown or completed export transfer.");
      if (operation === "finish") {
        if (state.parts.length || !state.hasMeta) throw new Error("Incomplete export transfer.");
        state.complete = true;
        return;
      }
      if (operation !== "chunk" || !["meta", ...arrays].includes(field) || typeof chunk !== "string" || chunk.length > CHUNK_CHARS || sequence !== state.sequence || (state.field && state.field !== field)) throw new Error("Out-of-order export transfer.");
      state.field = field;
      state.sequence++;
      state.parts.push(chunk);
      if (last) {
        const value = JSON.parse(state.parts.join(""));
        if (field === "meta") {
          for (const [key, entry] of Object.entries(value)) if (!arrays.includes(key) && !["__proto__", "constructor", "prototype"].includes(key)) state.data[key] = entry;
          state.hasMeta = true;
        } else {
          // Decode each attachment immediately, avoiding a second full base64
          // copy of the entire archive in the extension process.
          if (field === "savedMedia" && value.base64) {
            const bytes = Uint8Array.from(atob(value.base64), c => c.charCodeAt(0));
            value.blob = new Blob([bytes], { type: value.type || "application/octet-stream" });
            delete value.base64;
          }
          state.data[field].push(value);
        }
        state.parts = []; state.sequence = 0; state.field = null;
      }
    }
    function take(id) {
      const state = transfers.get(id);
      if (!state?.complete) throw new Error("Export transfer did not finish. No partial file was created.");
      transfers.delete(id);
      return state.data;
    }
    return { receive, take, clear: () => transfers.clear() };
  }
  return { send, receiver, CHUNK_CHARS };
})();
