const crypto = require("crypto");

const CRLF = "\r\n";

function randomToken(bytes = 8) {
    return crypto.randomBytes(bytes).toString("hex");
}

function sanitizeSipUser(value, fallback = "unknown") {
    const raw = String(value || "").trim();
    const user = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
    return (user.replace(/^sip:/i, "").replace(/[^A-Za-z0-9_.!~*'()+-]/g, "") || fallback);
}

function sipMessage(startLine, headers, body = "") {
    const content = String(body || "");
    const lines = [startLine];
    for (const [name, value] of headers) {
        if (value === undefined || value === null || value === "") continue;
        lines.push(`${name}: ${value}`);
    }
    lines.push(`Content-Length: ${Buffer.byteLength(content)}`);
    return `${lines.join(CRLF)}${CRLF}${CRLF}${content}`;
}

function splitSipPayload(raw) {
    const text = String(raw || "");
    const splitAt = text.indexOf(`${CRLF}${CRLF}`);
    if (splitAt < 0) return { head: text, body: "" };
    return {
        head: text.slice(0, splitAt),
        body: text.slice(splitAt + 4),
    };
}

function parseSipMessage(raw) {
    const { head, body } = splitSipPayload(raw);
    const lines = head.split(/\r\n/).filter(Boolean);
    const startLine = lines.shift() || "";
    const headers = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (!headers[name]) headers[name] = value;
        else headers[name] = `${headers[name]}, ${value}`;
    }
    return { startLine, headers, body };
}

function getStatusCode(startLine) {
    const match = String(startLine || "").match(/^SIP\/2\.0\s+(\d{3})\b/);
    return match ? Number(match[1]) : null;
}

function getMethod(startLine) {
    const match = String(startLine || "").match(/^([A-Z]+)\s+sip:/);
    return match ? match[1] : null;
}

function tagFromToHeader(value) {
    const match = String(value || "").match(/;\s*tag=([^;\s]+)/i);
    return match ? match[1] : "";
}

function sendUdp(socket, message, port, host) {
    return new Promise((resolve, reject) => {
        socket.send(Buffer.from(message), port, host, (err) => (err ? reject(err) : resolve()));
    });
}

function bindSocket(socket, { port = 0, bindIp = "0.0.0.0" } = {}) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            socket.off("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            socket.off("error", onError);
            resolve(socket.address());
        };
        socket.once("error", onError);
        socket.once("listening", onListening);
        socket.bind(port, bindIp);
    });
}

module.exports = {
    CRLF,
    randomToken,
    sanitizeSipUser,
    sipMessage,
    parseSipMessage,
    getStatusCode,
    getMethod,
    tagFromToHeader,
    sendUdp,
    bindSocket,
};
