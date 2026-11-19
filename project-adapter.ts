import {request} from "node:http";
export const callProjectAdapter = (path:string, payload:Record<string,unknown>, signal?:AbortSignal):Promise<unknown> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        socketPath: path, signal,
        path: "/",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", reject);
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 65536) req.destroy(Error("adapter response too large"));
          else chunks.push(b);
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("adapter failed");
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(Error("adapter timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
