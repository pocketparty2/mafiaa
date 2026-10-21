const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");
const { randomInt } = require("node:crypto");

initializeApp();
const db = getFirestore();

const REGION = "europe-west1";
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;

const DURATIONS = {
  night: 30,
  discussion: 45,
  voting: 20
};

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  return request.auth.uid;
}

function cleanName(value) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "Enter a player name.");
  }

  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 18) {
    throw new HttpsError(
      "invalid-argument",
      "Names must be 2–18 characters."
    );
  }
  return name;
}

function cleanCode(value) {
  if (typeof value !== "string" || !/^[A-Z]{4}$/.test(value)) {
    throw new HttpsError(
      "invalid-argument",
      "Enter a valid four-letter room code."
    );
  }
  return value;
}

function roomRef(code) {
  return db.collection("rooms").doc(code);
}

function playerRef(code, uid) {
  return roomRef(code).collection("players").doc(uid);
}

function roleRef(code, uid) {
  return roomRef(code).collection("private")
    .doc("roles").collection("members").doc(uid);
}

function actionRef(code, uid) {
  return roomRef(code).collection("actions").doc(uid);
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function mafiaCount(count) {
  if (count <= 6) return 1;
  if (count <= 9) return 2;
  return 3;
}

function phaseEnd(phase) {
  return Date.now() + DURATIONS[phase] * 1000;
}

function assertMember(room, uid) {
  if (!room || !room.memberUids?.includes(uid)) {
    throw new HttpsError("permission-denied", "You are not in this room.");
  }
}

function assertHost(room, uid) {
  assertMember(room, uid);
  if (room.hostUid !== uid) {
    throw new HttpsError("permission-denied", "Only the host can do that.");
  }
}

async function readRoom(code) {
  const snap = await roomRef(code).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Room not found.");
  }
  return snap.data();
}

async function readRole(code, uid) {
  const snap = await roleRef(code, uid).get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "Your role is not assigned.");
  }
  return snap.data();
}

async function finishIfWon(code) {
  const room = await readRoom(code);
  if (room.phase === "finished") return room.winner;

  const playersSnap = await roomRef(code).collection("players")
    .where("alive", "==", true).get();

  let mafia = 0;
  let town = 0;

  for (const p of playersSnap.docs) {
    const role = await readRole(code, p.id);
    if (role.role === "Mafia") mafia++;
    else town++;
  }

  let winner = null;
  if (mafia === 0) winner = "Town";
  else if (mafia >= town) winner = "Mafia";

  if (winner) {
    await roomRef(code).update({
      phase: "finished",
      winner,
      endsAt: null,
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  return winner;
}

exports.createRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const name = cleanName(request.data.name);
  const revealRoles = request.data.revealRoles !== false;

  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += String.fromCharCode(65 + randomInt(26));
    }

    const ref = roomRef(code);
    const existing = await ref.get();
    if (existing.exists) continue;

    const batch = db.batch();
    batch.set(ref, {
      code,
      hostUid: uid,
      memberUids: [uid],
      phase: "lobby",
      round: 0,
      winner: null,
      endsAt: null,
      settings: { revealRoles },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    batch.set(playerRef(code, uid), {
      uid,
      name,
      alive: true,
      ready: true,
      joinedAt: FieldValue.serverTimestamp()
    });

    try {
      await batch.commit();
      return { code };
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }

  throw new HttpsError("resource-exhausted", "Couldn't create a room. Try again.");
});

exports.joinRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const name = cleanName(request.data.name);
  const ref = roomRef(code);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "That room doesn't exist.");
    }

    const room = snap.data();
    const existing = await tx.get(playerRef(code, uid));

    if (existing.exists) return;
    if (room.phase !== "lobby") {
      throw new HttpsError("failed-precondition", "This game has already started.");
    }
    if (room.memberUids.length >= MAX_PLAYERS) {
      throw new HttpsError("resource-exhausted", "This room is full.");
    }

    tx.update(ref, {
      memberUids: [...room.memberUids, uid],
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.set(playerRef(code, uid), {
      uid,
      name,
      alive: true,
      ready: false,
      joinedAt: FieldValue.serverTimestamp()
    });
  });

  return { code };
});

exports.setReady = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const ready = Boolean(request.data.ready);
  const room = await readRoom(code);
  assertMember(room, uid);

  if (room.phase !== "lobby") {
    throw new HttpsError("failed-precondition", "The game has started.");
  }

  await playerRef(code, uid).update({ ready });
  return { ok: true };
});

exports.setSettings = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const room = await readRoom(code);
  assertHost(room, uid);

  if (room.phase !== "lobby") {
    throw new HttpsError("failed-precondition", "Settings are locked after starting.");
  }

  await roomRef(code).update({
    "settings.revealRoles": request.data.revealRoles === true,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});

exports.startGame = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const ref = roomRef(code);
  const room = await readRoom(code);
  assertHost(room, uid);

  if (room.phase !== "lobby") {
    throw new HttpsError("failed-precondition", "The game has already started.");
  }

  const playersSnap = await ref.collection("players").get();
  const players = playersSnap.docs.map((doc) => ({
    uid: doc.id,
    ...doc.data()
  }));

  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new HttpsError("failed-precondition", "You need 5–12 players.");
  }
  if (players.some((p) => !p.ready)) {
    throw new HttpsError("failed-precondition", "Everyone must be ready.");
  }

  const roles = [
    ...Array(mafiaCount(players.length)).fill("Mafia"),
    "Detective",
    "Doctor"
  ];
  while (roles.length < players.length) roles.push("Townsperson");

  const shuffledRoles = shuffle(roles);
  const batch = db.batch();

  players.forEach((player, index) => {
    batch.set(roleRef(code, player.uid), {
      role: shuffledRoles[index],
      lastInvestigation: null
    });

    batch.update(playerRef(code, player.uid), {
      alive: true,
      roleReveal: null
    });
  });

  batch.update(ref, {
    phase: "night",
    round: 1,
    endsAt: phaseEnd("night"),
    winner: null,
    updatedAt: FieldValue.serverTimestamp()
  });

  await batch.commit();
  return { ok: true };
});

exports.getMyState = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const room = await readRoom(code);
  assertMember(room, uid);

  const player = await playerRef(code, uid).get();
  const role = await roleRef(code, uid).get();

  const result = {
    phase: room.phase,
    round: room.round,
    winner: room.winner,
    role: role.exists ? role.data().role : null,
    investigation: role.exists ? role.data().lastInvestigation : null,
    mafiaTeammates: []
  };

  if (role.exists && role.data().role === "Mafia") {
    const allPlayers = await roomRef(code).collection("players").get();
    for (const p of allPlayers.docs) {
      if (p.id === uid) continue;
      const otherRole = await roleRef(code, p.id).get();
      if (otherRole.exists && otherRole.data().role === "Mafia") {
        result.mafiaTeammates.push({
          uid: p.id,
          name: p.data().name
        });
      }
    }
  }

  result.alive = player.exists && player.data().alive;
  return result;
});

exports.submitNightAction = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const targetUid = request.data.targetUid;

  if (typeof targetUid !== "string" || targetUid === uid) {
    throw new HttpsError("invalid-argument", "Choose another player.");
  }

  const room = await readRoom(code);
  assertMember(room, uid);

  if (room.phase !== "night" || Date.now() >= room.endsAt) {
    throw new HttpsError("failed-precondition", "It isn't night anymore.");
  }

  const [actor, target] = await Promise.all([
    playerRef(code, uid).get(),
    playerRef(code, targetUid).get()
  ]);

  if (!actor.exists || !actor.data().alive || !target.exists || !target.data().alive) {
    throw new HttpsError("failed-precondition", "Both players must be alive.");
  }

  const role = await readRole(code, uid);
  const allowed = {
    Mafia: ["kill"],
    Detective: ["investigate"],
    Doctor: ["protect"]
  };

  const action = request.data.action;
  if (!allowed[role.role]?.includes(action)) {
    throw new HttpsError("permission-denied", "Your role can't do that.");
  }

  await actionRef(code, uid).set({
    action,
    targetUid,
    round: room.round,
    submittedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});

exports.submitVote = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const targetUid = request.data.targetUid;

  if (typeof targetUid !== "string" || targetUid === uid) {
    throw new HttpsError("invalid-argument", "Choose another player.");
  }

  const room = await readRoom(code);
  assertMember(room, uid);

  if (room.phase !== "voting" || Date.now() >= room.endsAt) {
    throw new HttpsError("failed-precondition", "Voting is closed.");
  }

  const [actor, target] = await Promise.all([
    playerRef(code, uid).get(),
    playerRef(code, targetUid).get()
  ]);

  if (!actor.exists || !actor.data().alive || !target.exists || !target.data().alive) {
    throw new HttpsError("failed-precondition", "Both players must be alive.");
  }

  await actionRef(code, uid).set({
    action: "vote",
    targetUid,
    round: room.round,
    submittedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});

exports.advanceIfDue = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const ref = roomRef(code);
  const room = await readRoom(code);
  assertMember(room, uid);

  if (room.phase === "lobby" || room.phase === "finished") {
    return { ok: true, phase: room.phase };
  }

  if (!room.endsAt || Date.now() < room.endsAt) {
    return { ok: true, phase: room.phase };
  }

  const playersSnap = await ref.collection("players").get();
  const players = playersSnap.docs.map((d) => ({
    uid: d.id,
    ...d.data()
  }));
  const actionsSnap = await ref.collection("actions").get();
  const actions = actionsSnap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .filter((a) => a.round === room.round);

  const playerById = new Map(players.map((p) => [p.uid, p]));
  const roles = new Map();

  for (const p of players) {
    roles.set(p.uid, (await readRole(code, p.uid)).role);
  }

  // Re-check the phase and deadline transactionally so simultaneous
  // clients cannot advance the same round twice.
  const changed = await db.runTransaction(async (tx) => {
    const latestSnap = await tx.get(ref);
    if (!latestSnap.exists) return false;

    const latest = latestSnap.data();
    if (latest.phase !== room.phase ||
        latest.round !== room.round ||
        latest.endsAt !== room.endsAt ||
        Date.now() < latest.endsAt) {
      return false;
    }

    if (room.phase === "night") {
      const kills = actions.filter((a) => a.action === "kill");
      const protections = actions.filter((a) => a.action === "protect");
      const investigations = actions.filter((a) => a.action === "investigate");

      const counts = {};
      for (const action of kills) {
        if (roles.get(action.uid) === "Mafia" &&
            playerById.get(action.uid)?.alive &&
            playerById.get(action.targetUid)?.alive) {
          counts[action.targetUid] = (counts[action.targetUid] || 0) + 1;
        }
      }

      const protectionTargets = new Set(
        protections
          .filter((a) => roles.get(a.uid) === "Doctor" &&
            playerById.get(a.uid)?.alive &&
            playerById.get(a.targetUid)?.alive)
          .map((a) => a.targetUid)
      );

      const candidates = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      let victimUid = null;

      if (candidates.length && (
        candidates.length === 1 || candidates[0][1] > candidates[1][1]
      )) {
        victimUid = candidates[0][0];
      }

      if (victimUid && !protectionTargets.has(victimUid)) {
        const victimRole = roles.get(victimUid);
        const updates = { alive: false };
        if (latest.settings.revealRoles) {
          updates.roleReveal = victimRole;
        }
        tx.update(playerRef(code, victimUid), updates);
      }

      for (const action of investigations) {
        if (roles.get(action.uid) !== "Detective" ||
            !playerById.get(action.uid)?.alive ||
            !playerById.get(action.targetUid)?.alive) continue;

        tx.update(roleRef(code, action.uid), {
          lastInvestigation: {
            targetUid: action.targetUid,
            targetName: playerById.get(action.targetUid).name,
            isMafia: roles.get(action.targetUid) === "Mafia",
            round: room.round
          }
        });
      }

      tx.update(ref, {
        phase: "discussion",
        endsAt: phaseEnd("discussion"),
        updatedAt: FieldValue.serverTimestamp()
      });
    } else if (room.phase === "discussion") {
      tx.update(ref, {
        phase: "voting",
        endsAt: phaseEnd("voting"),
        updatedAt: FieldValue.serverTimestamp()
      });
    } else if (room.phase === "voting") {
      const counts = {};
      for (const action of actions) {
        if (action.action === "vote" &&
            playerById.get(action.uid)?.alive &&
            playerById.get(action.targetUid)?.alive) {
          counts[action.targetUid] = (counts[action.targetUid] || 0) + 1;
        }
      }

      const candidates = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (candidates.length &&
          (candidates.length === 1 || candidates[0][1] > candidates[1][1])) {
        const victimUid = candidates[0][0];
        const updates = { alive: false };
        if (latest.settings.revealRoles) {
          updates.roleReveal = roles.get(victimUid);
        }
        tx.update(playerRef(code, victimUid), updates);
      }

      tx.update(ref, {
        phase: "night",
        round: room.round + 1,
        endsAt: phaseEnd("night"),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    return true;
  });

  if (changed) {
    await finishIfWon(code);

    // Remove old actions so a previous round cannot affect the next one.
    const batch = db.batch();
    actionsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  const finalRoom = await readRoom(code);
  return { ok: true, phase: finalRoom.phase, winner: finalRoom.winner };
});

exports.leaveRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data.code);
  const ref = roomRef(code);

  await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(ref);
    if (!roomSnap.exists) return;

    const room = roomSnap.data();
    if (!room.memberUids.includes(uid)) return;

    const pRef = playerRef(code, uid);
    const playerSnap = await tx.get(pRef);
    if (!playerSnap.exists) return;

    if (room.phase !== "lobby") {
      // During a game, preserve membership for private-state access,
      // but mark the departing player as eliminated.
      tx.update(pRef, { alive: false });
      return;
    }

    const remaining = room.memberUids.filter(id => id !== uid);

    if (remaining.length === 0) {
      tx.delete(pRef);
      tx.delete(ref);
      return;
    }

    const update = {
      memberUids: remaining,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (room.hostUid === uid) {
      update.hostUid = remaining[0];
    }

    tx.update(ref, update);
    tx.delete(pRef);
  });

  return { ok: true };
});
