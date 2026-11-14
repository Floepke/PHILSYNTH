// Timer for the transport (src/transport.js): posts a tick every e.data ms, 0 stops it.
let t = null;
onmessage = (e) => {
  clearInterval(t);
  t = e.data > 0 ? setInterval(() => postMessage(0), e.data) : null;
};
