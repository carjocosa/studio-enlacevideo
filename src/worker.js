export class StudioRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.directorPassword = null;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url      = new URL(request.url);
    const name     = url.searchParams.get("name")     || "Sin nombre";
    const role     = url.searchParams.get("role")     || "guest";
    const password = url.searchParams.get("password") || "";

    if (role === "director") {
      if (!this.directorPassword) {
        this.directorPassword = password;
      } else if (password !== this.directorPassword) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const guestCount = [...this.sessions.values()].filter(s => s.role === "guest").length;
    if (role === "guest" && guestCount >= 5) {
      return new Response("Room full", { status: 403 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { ws: server, name, role });

    if (role === "guest") {
      this.notifyDirector({ type: "guest-joined", guestId: sessionId, name });
    }

    if (role === "program") {
      this.notifyDirector({ type: "program-connected" });
    }

    const director = [...this.sessions.entries()].find(([, s]) => s.role === "director");
    if (director && role === "guest") {
      server.send(JSON.stringify({ type: "director-present", directorId: director[0] }));
    }

    server.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      data.senderId   = sessionId;
      data.senderName = name;
      data.senderRole = role;

      switch (data.type) {
        case "offer":
        case "answer":
        case "ice-candidate":
          if (data.targetId) this.sendTo(data.targetId, data);
          break;
        case "kick-guest":
          this.kickGuest(data.guestId);
          break;
        case "remote-mute":
          this.sendTo(data.guestId, { type: "force-mute", muted: data.muted });
          break;
        case "layout-change":
          this.notifyProgram(data);
          break;
        case "scene-update":
          this.notifyProgram(data);
          break;
        case "program-ready":
          this.notifyDirector({ type: "program-ready" });
          break;
        case "get-guests":
          const guests = [...this.sessions.entries()]
            .filter(([, s]) => s.role === "guest")
            .map(([id, s]) => ({ id, name: s.name }));
          server.send(JSON.stringify({ type: "guests-list", guests }));
          break;
      }
    });

    server.addEventListener("close", () => {
      this.sessions.delete(sessionId);
      if (role === "guest") {
        this.notifyDirector({ type: "guest-left", guestId: sessionId, name });
        this.notifyProgram({ type: "guest-left", guestId: sessionId });
      }
      if (role === "director") {
        this.broadcastAll({ type: "director-disconnected" });
        this.directorPassword = null;
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  sendTo(id, data) {
    const s = this.sessions.get(id);
    if (s) { try { s.ws.send(JSON.stringify(data)); } catch(e) {} }
  }

  notifyDirector(data) {
    for (const [, s] of this.sessions.entries()) {
      if (s.role === "director") { try { s.ws.send(JSON.stringify(data)); } catch(e) {} }
    }
  }

  notifyProgram(data) {
    for (const [, s] of this.sessions.entries()) {
      if (s.role === "program") { try { s.ws.send(JSON.stringify(data)); } catch(e) {} }
    }
  }

  broadcastAll(data) {
    for (const [, s] of this.sessions.entries()) {
      try { s.ws.send(JSON.stringify(data)); } catch(e) {}
    }
  }

  kickGuest(guestId) {
    const guest = this.sessions.get(guestId);
    if (guest) {
      try { guest.ws.send(JSON.stringify({ type: "kicked" })); guest.ws.close(); } catch(e) {}
      this.sessions.delete(guestId);
      this.notifyProgram({ type: "guest-left", guestId });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/signal/")) {
      const roomName = url.pathname.split("/signal/")[1];
      if (!roomName) return new Response("Room required", { status: 400 });
      const id   = env.STUDIO_ROOM.idFromName(roomName);
      const room = env.STUDIO_ROOM.get(id);
      return room.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
