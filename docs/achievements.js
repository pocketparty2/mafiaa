export const ACHIEVEMENTS = [  
  { id: "first-suspect", category: "Winning", name: "First Suspect", requirement: "Win your first round", title: "First Suspect", colors: ["#d4d4d4", "#b5b5b5"], kind: "wins", target: 1 },
  { id: "street-smart", category: "Winning", name: "Street Smart", requirement: "Win 5 rounds", title: "Street Smart", colors: ["#999391", "#634e47"], kind: "wins", target: 5 },
  { id: "truth-seeker", category: "Winning", name: "Truth Seeker", requirement: "Win 10 rounds", title: "Truth Seeker", colors: ["#4e6140", "#588c30"], kind: "wins", target: 10 },
  { id: "undefeated", category: "Winning", name: "Undefeated", requirement: "Win 25 rounds", title: "Undefeated", colors: ["#e8c838", "#ffea8a"], kind: "wins", target: 25 },
  { id: "untouchable", category: "Winning", name: "Untouchable", requirement: "Win 50 rounds", title: "Untouchable", colors: ["#941e4f", "#6b0f35"], kind: "wins", target: 50 },
  { id: "mastermind", category: "Winning", name: "Mastermind", requirement: "Win 100 rounds", title: "Mastermind", colors: ["#bd0606", "#9c3232"], kind: "wins", target: 100 },
  { id: "power-in-numbers", category: "Role", name: "Power in Numbers", requirement: "Win as a Townsperson", title: "Honest Citizen", colors: ["#2ECC71", "#117864"], kind: "role", role: "Townsperson" },
  { id: "case-closed", category: "Role", name: "Case Closed", requirement: "Win as a Detective", title: "Sleuthing", colors: ["#2980B9", "#1B2A4A"], kind: "role", role: "Detective" }, 
  { id: "mourning-does-the-body-no-good", category: "Role", name: "Mourning Does The Body No Good", requirement: "Win as Mafia", title: "Caporegime", colors: ["#E74C3C", "#640000"], kind: "role", role: "Mafia" },
  { id: "do-no-harm", category: "Role", name: "Do No Harm", requirement: "Win as a Doctor", title: "Lifesaver", colors: ["#00F2FE", "#4FACFE"], kind: "role", role: "Doctor" },
  { id: "executive-order", category: "Role", name: "Executive Order", requirement: "Win as a Mayor", title: "Honorable", colors: ["#FFE000", "#799F0C"], kind: "role", role: "Mayor" },
  { id: "spying-duty", category: "Role", name: "Spying Duty", requirement: "Win as a Tracker", title: "Night Stalker", colors: ["#8E44AD", "#2C3E50"], kind: "role", role: "Tracker" },
  { id: "for-honor-and-glory", category: "Role", name: "For Honor & Glory!", requirement: "Win as a Knight", title: "The Aegis", colors: ["#E0E0E0", "#7F8C8D"], kind: "role", role: "Knight" },
  { id: "quiet-in-the-court", category: "Role", name: "Quiet in the Court", requirement: "Win as a Silencer", title: "Voice Thief", colors: ["#95A5A6", "#34495E"], kind: "role", role: "Silencer" },
  { id: "fools-errand", category: "Role", name: "Fool's Errand", requirement: "Win as a Jester", title: "Ultimate Wildcard", colors: ["#FF007F", "#7B1FA2"], kind: "role", role: "Jester" },
  { id: "finders-keepers", category: "Role", name: "Finders Keepers", requirement: "Win as a Thief", title: "Shadow Burglar", colors: ["#919191", "#d4d4d4"], kind: "role", role: "Thief" },
  { id: "day-1-blunder", category: "Deaths", name: "Day 1 Blunder", requirement: "Be voted out on day 1 as a Town-aligned role", title: "Seriously Suspicious", colors: ["#FF6B6B", "#8C3B3B"], kind: "flag", flag: "day1TownVoteOut" },
  { id: "incompetence", category: "Deaths", name: "Incompetence", requirement: "Be voted out on day 1 as a Mafia-aligned role", title: "Hopeless Mafia", colors: ["#E74C3C", "#640000"], kind: "flag", flag: "day1MafiaVoteOut" },
  { id: "malpractice", category: "Deaths", name: "Malpractice", requirement: "Be voted out as the Doctor", title: "Flatlined", colors: ["#4DB6AC", "#455A64"], kind: "flag", flag: "doctorVoteOut" },
  { id: "unanimous", category: "Deaths", name: "Unanimous", requirement: "Be voted out unanimously by every other player", title: "Public Enemy No. 1", colors: ["#d0d6d1", "#364238"], kind: "flag", flag: "unanimousVoteOut" },
  { id: "night-one-casualty", category: "Deaths", name: "Night One Casualty", requirement: "Die before day 1", title: "First Blood", colors: ["#FF5252", "#4A0007"], kind: "flag", flag: "nightOneCasualty" },
  { id: "fatal-discovery", category: "Deaths", name: "Fatal Discovery", requirement: "Die as the Detective on the exact night you investigate a Mafia member", title: "Curiosity Killed the Cat", colors: ["#7B1FA2", "#1A237E"], kind: "flag", flag: "fatalDiscovery" },
  { id: "silent-verdict", category: "Miscellaneous", name: "Silent Verdict", requirement: "Win as Town without casting an incorrect vote", title: "Flawless Voice", colors: ["#FFFFFF", "#90d7e0"], kind: "flag", flag: "silentVerdict" },
  { id: "clean-sweep", category: "Miscellaneous", name: "Clean Sweep", requirement: "Win as Mafia without losing a teammate (only counts with 2+ Mafia)", title: "Unseen Cartel", colors: ["#D32F2F", "#750000"], kind: "flag", flag: "cleanSweep" },
  { id: "sherlocks-intuition", category: "Miscellaneous", name: "Sherlock's Intuition", requirement: "As the Detective, find a Mafia member on night 1", title: "Keen Eye", colors: ["#00B0FF", "#0D47A1"], kind: "flag", flag: "sherlocksIntuition" },
  { id: "muzzled", category: "Miscellaneous", name: "Muzzled", requirement: "As the Silencer, silence the same target 3 times in a row in one match", title: "Shh....", colors: ["#B0BEC5", "#263238"], kind: "flag", flag: "muzzled" },
  { id: "clutch-save", category: "Miscellaneous", name: "Clutch Save", requirement: "As the Doctor, successfully protect 2 people from Mafia attacks in one match", title: "Guardian Angel", colors: ["#26d7ff", "#b6edfa"], kind: "flag", flag: "clutchSave" },
  { id: "its-not-personal", category: "Role", name: "It's Not Personal!", requirement: "Win by getting your target voted out as the Bounty Hunter", title: "Apex Predator", colors: ["#39dbc3", "#94ffef"], kind: "flag", flag: "bountyHunterWin" }
];

export const ACHIEVEMENT_CATEGORIES = ["Winning", "Role", "Deaths", "Miscellaneous"];

export function achievementById(id) {
  return ACHIEVEMENTS.find(item => item.id === id) || null;
}

export function stylizeTitle(value) {
  return Array.from(String(value || "")).map(char => {
    const code = char.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D63C + code - 65);
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D656 + code - 97);
    return char;
  }).join("");
}

export function applyTitleDesign(element, id) {
  if (!element) return;
  const achievement = achievementById(id);
  if (!achievement) {
    element.classList.add("hidden");
    element.textContent = "";
    return;
  }
  element.classList.remove("hidden");
  element.classList.add("player-title");
  element.textContent = "[ " + stylizeTitle(achievement.title) + " ]";
  const [top, bottom] = achievement.colors;
  const average = [0, 2, 4].map(index =>
    Math.round((parseInt(top.slice(index + 1, index + 3), 16) + parseInt(bottom.slice(index + 1, index + 3), 16)) / 2)
  );
  const border = "#" + average.map(value => Math.round(value * 0.75).toString(16).padStart(2, "0")).join("");
  element.style.setProperty("--title-stroke", border);
  element.style.backgroundImage = "linear-gradient(180deg, " + top + ", " + bottom + ")";
  element.style.backgroundColor = "transparent";
  element.style.backgroundClip = "text";
  element.style.setProperty("-webkit-background-clip", "text");
  element.style.backgroundOrigin = "initial";
  element.style.webkitTextFillColor = "transparent";
  element.style.webkitTextStroke = "0";
  element.style.color = "transparent";
  element.style.border = "0";
  element.style.padding = "0";
  element.style.borderRadius = "0";
}


export function roleTitleColors(role) {
  const achievement = ACHIEVEMENTS.find(item =>
    (item.kind === "role" && item.role === role) ||
    (role === "Bounty Hunter" && item.id === "its-not-personal")
  );
  return achievement?.colors || ["#888888", "#555555"];
}
