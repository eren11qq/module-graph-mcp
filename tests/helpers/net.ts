import net from 'node:net';

/** Grab a free loopback port and fully release it before returning. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no address'));
      srv.close(() => resolve(addr.port));
    });
    srv.once('error', reject);
  });
}
