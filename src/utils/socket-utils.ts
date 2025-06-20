import net from "net";

export const connectSocket = (ip: string, port: number): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port, timeout: 5000 });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
    socket.once("timeout", () => reject(new Error(`Connection timeout to ${ip}:${port}`)));
  });
};