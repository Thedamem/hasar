import net from "node:net";

type WyomingHeader = {
  type?: string;
  data?: Record<string, unknown>;
  data_length?: number;
  payload_length?: number;
};

export async function synthesizePiper(
  url: string,
  text: string,
  voice: string,
): Promise<Buffer> {
  const target = new URL(url);
  if (target.protocol !== "tcp:") {
    throw new Error("Piper URL must use tcp://");
  }
  const host = target.hostname;
  const port = Number(target.port || 10200);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let rate = 22_050;
    let width = 2;
    let channels = 1;
    let settled = false;
    let buffer = Buffer.alloc(0);

    const socket = net.connect({ host, port });
    const timer = setTimeout(() => finish(new Error("Piper request timed out")), 60_000);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      if (!chunks.length) {
        reject(new Error("Piper returned no audio"));
        return;
      }
      resolve(wav(Buffer.concat(chunks), rate, width, channels));
    }

    function handle(header: WyomingHeader, payload: Buffer) {
      switch (header.type) {
        case "audio-start":
          rate = Number(header.data?.rate ?? rate);
          width = Number(header.data?.width ?? width);
          channels = Number(header.data?.channels ?? channels);
          break;
        case "audio-chunk":
          if (payload.length) chunks.push(Buffer.from(payload));
          break;
        case "audio-stop":
          finish();
          break;
        case "error":
          finish(
            new Error(
              String(
                (header.data as { text?: string } | undefined)?.text ??
                  "Piper returned an error",
              ),
            ),
          );
          break;
        default:
          break;
      }
    }

    function parse() {
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let header: WyomingHeader;
        try {
          header = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as WyomingHeader;
        } catch {
          finish(new Error("Piper returned a malformed Wyoming header"));
          return;
        }
        const dataLength = Number(header.data_length ?? 0);
        const payloadLength = Number(header.payload_length ?? 0);
        const total = newline + 1 + dataLength + payloadLength;
        if (!Number.isFinite(total) || buffer.length < total) return;
        const payload = buffer.subarray(
          newline + 1 + dataLength,
          newline + 1 + dataLength + payloadLength,
        );
        buffer = buffer.subarray(total);
        handle(header, payload);
        if (settled) return;
      }
    }

    socket.on("connect", () => {
      const data: Record<string, unknown> = { text };
      if (voice) data.voice = { name: voice };
      socket.write(`${JSON.stringify({ type: "synthesize", data })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("Piper closed the connection before audio-stop"));
    });
  });
}

function wav(pcm: Buffer, rate: number, width: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = rate * channels * width;
  const blockAlign = channels * width;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
