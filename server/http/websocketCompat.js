// ws/zlib cannot encode an 8-bit server window. Preserve the handshake without
// deflate only if EVERY offered extension limits the server below that window.
export function narrowDeflateOffer(header) {
  if (typeof header !== 'string') return false;
  const offers = header.split(',').map(s => s.trim()).filter(s => /^permessage-deflate\b/i.test(s));
  return offers.length > 0 && offers.every(offer => {
    const m = /(?:^|;)\s*server_max_window_bits\s*=\s*"?(\d+)"?/i.exec(offer);
    return m && Number(m[1]) === 8;
  });
}
export function meterSocket(ws, req, traffic) {
  const socket = req.socket;
  traffic.wsOpen(socket);
  const send = ws.send;
  ws.send = function (data, ...args) { traffic.wsSent(data); return send.call(this, data, ...args); };
  ws.on('message', data => traffic.wsReceived(data));
  ws.once('close', () => traffic.wsClose(socket));
}
