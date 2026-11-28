// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugin_catalog.ts - P-PLUGINS.1 (ADR-0461): the one catalog behind the Plugins drawer.
//
// PREMIUM: the LUCID apps sold at $29.99 one-time (ADR-0463), or at $9.99 a month (the Meeting Hub per license with a
// quote for teams, and the Tactical GenAI Trainer; P-PLUGINS.PREMIUM2, ADR-0699), plus the link-outs that are never sold here (LEAPS
// keeps its own subscription; MDMP Engine and Joint Planning Engine are Black Arrow Systems partner apps,
// ADR-0465), the Lucid Agent Worlds at $9.99 one-time each under their own heading (ADR-0648), and above them the
// two Lucid Agent World Packs, Patron Class and Sponsor (P-WORLDS.STORE1). FREE: the ADR-0158/0181 integrations
// registry, moved here from the retired `#scrim` marketplace with its featured / built-in / planned semantics
// intact, plus the capabilities LUCID already ships.
//
// Pure data and pure decisions (no DOM, no fetch): plugins_flyout.ts renders and wires; this module decides.
// Ids are stable forever (AGENTS.md invariant 9) and double as the entitlement id (PLUGINS-CONTRACT).

import { decidePackAction, isEntitled, type Entitlement, type GovAccessStatus } from "../../harness/market/entitlement.ts";
import type { PluginGate } from "./bridge.ts";

export type PluginTier = "premium" | "free";
export type PluginSection = "civilian" | "government";
/** Palette token a generated poster is tinted with (styles.css `--<tone>-rgb`), so posters follow the theme. */
export type PosterTone = "accent" | "cyan" | "green" | "amber" | "blue" | "violet";

/** How a card's picture is made. `loop`: a bundled `<id>-loop.mp4` plays over the poster while visible.
 *  `poster: "webp"`: a bundled `<id>-poster.webp`; `"generated"`: an SVG drawn from `glyph` + `tone`. */
export interface PluginMedia { loop: boolean; poster: "webp" | "generated"; glyph: string; tone: PosterTone }

interface PremiumBase {
  id: string;
  name: string;
  kicker: string;
  pitch: string;
  /** The "With LUCID Agent" line: what the plugin does once it lives inside LUCID. */
  lucid: string;
  section: PluginSection;
  media: PluginMedia;
  /** The drawer heading the card is listed under instead of its section's (WORLDS_GROUP for the worlds,
   *  WORLD_PACKS_GROUP for the world packs). */
  group?: string;
}
/** Sold through LUCID: `price` is the label; the Stripe price is looked up by `lookupKey` server-side. One-time by
 *  default; `billing: "monthly"` (P-PLUGINS.PREMIUM2, ADR-0699) is a subscription, `perLicense` says it is priced per
 *  license, and `quoteUrl` (https only, opened in the browser) is where a team asks for several licenses.
 *  `available` is true only once the package is built, signed and verified; until then the card says Coming soon
 *  and sells nothing. */
export interface SoldPlugin extends PremiumBase {
  sale: "buy"; lookupKey: string; available: boolean; price: string;
  billing?: "monthly"; perLicense?: boolean; quoteUrl?: string;
}
/** Never sold through LUCID: the card opens `href` in the system browser. */
export interface LinkOutPlugin extends PremiumBase { sale: "link"; href: string; linkLabel: string; partner?: string }
export type PremiumPlugin = SoldPlugin | LinkOutPlugin;

/** The one-time price of a LUCID app (ADR-0463). */
const APP_PRICE = "$29.99";
/** The one-time price of a Lucid Agent World (ADR-0648). */
const WORLD_PRICE = "$9.99";
/** P-PLUGINS.PREMIUM2 (ADR-0699): the monthly price of a LUCID app sold by subscription. */
const MONTHLY_PRICE = "$9.99";
/** P-PLUGINS.PREMIUM2: where a team asks for a quote on several Meeting Hub licenses (the Meeting Hub site's form). */
export const MEETING_HUB_QUOTE_URL = "https://meetinghub.lucid-agents.com/#insider";

/** P-PLUGINS.PREMIUM2: the price line a sold card shows: "One-time $29.99", "$9.99/mo" or "$9.99/mo per license". */
export function priceLabel(p: Pick<SoldPlugin, "price" | "billing" | "perLicense">): string {
  if (p.billing !== "monthly") return `One-time ${p.price}`;
  return `${p.price}/mo${p.perLicense ? " per license" : ""}`;
}
/** The drawer heading of the Lucid Agent Worlds: add-on packs for the Visualize view (ADR-0648). */
export const WORLDS_GROUP = "Lucid Agent Worlds";
/** P-WORLDS.STORE1: the drawer heading of the Lucid Agent World Packs, the first section on PREMIUM. */
export const WORLD_PACKS_GROUP = "Lucid Agent World Packs";
/** The backend catalog ids of the two world packs (stable forever, invariant 9). */
export const SPONSOR_PACK_ID = "bundle-sponsor";
export const PATRON_PACK_ID = "bundle-patron";
/** Sponsor: exactly this many worlds are picked at checkout, and this many world credits are banked. */
export const SPONSOR_PICKS = 6;
export const SPONSOR_CREDITS = 6;
export const PLUGIN_LICENSE_NAME = "LUCID Premium Plugin License";
export const PLUGIN_LICENSE_URL = "https://lucid-agent.web.app/legal/plugins";
export const BLACK_ARROW = "Black Arrow Systems";

export const PREMIUM_PLUGINS: PremiumPlugin[] = [
  {
    id: "pathfinder", name: "Pathfinder", section: "civilian", sale: "buy", lookupKey: "PLG-PATHFINDER-OTF", available: true, price: APP_PRICE,
    kicker: "Career and relocation",
    pitch: "Evidence-first career and relocation planner for the whole household: resume parsing, jobs near the target region for you and your partner, a fact-checked resume tailored to each opening, commute baselines, FEMA flood zones, and verified housing and volunteer research.",
    lucid: "Runs on your machine and thinks with your LUCID model, no separate AI key. The agent can search jobs, tailor a resume, and build a relocation brief through Pathfinder's tools.",
    media: { loop: true, poster: "webp", glyph: "search", tone: "cyan" },
  },
  {
    id: "myhome", name: "MyHome", section: "civilian", sale: "buy", lookupKey: "PLG-MYHOME-OTF", available: true, price: APP_PRICE,
    kicker: "Local-first household AI",
    pitch: "One app for a household's health, insurance, and property tax on a local knowledge graph that stays on your computer. Care Finder searches plan doctor directories by voice, and Home Tax scores each taxing authority on your bill.",
    lucid: "Bills, EOBs and policy documents are read by your LUCID model instead of a separate key. The agent can summarize the household, list upcoming renewals and claims, and score tax authorities through MyHome's tools.",
    media: { loop: true, poster: "webp", glyph: "folder", tone: "green" },
  },
  {
    id: "agentictrade187", name: "AgenticTrade187", section: "civilian", sale: "buy", lookupKey: "PLG-AT187-OTF", available: true, price: APP_PRICE,
    kicker: "Agent-ready trading desk",
    pitch: "A trading desk AI agents can run: paper trading by default, a server-side risk gate, Strategy Studio backtests with overfitting receipts, the Market Map screener, Smart Alerts that say why they fired, and 3D charts.",
    lucid: "Its 47 MCP tools register with the agent, so LUCID can research tickers, run backtests, and journal lessons, while every order stays behind the risk gate.",
    media: { loop: true, poster: "webp", glyph: "gauge", tone: "amber" },
  },
  {
    id: "homeschooltutor", name: "HomeschoolTutor", section: "civilian", sale: "buy", lookupKey: "PLG-HST-OTF", available: false, price: APP_PRICE,
    kicker: "Local-first learning companion",
    pitch: "A private learning companion for homeschooled kids on Miacademy: a Chrome extension with hint ladders that guide without giving the answer away, and a Learning Hub with daily quests, a Mastery Path, narrated story series, and 3D explainers.",
    lucid: "Will install the Learning Hub on the family computer and run its hints and Studio prompts on your LUCID model, with the Chrome extension as one Add to Chrome step.",
    media: { loop: true, poster: "webp", glyph: "bulb", tone: "violet" },
  },
  {
    // P-PLUGINS.PREMIUM2 (ADR-0699): a monthly subscription once it sells.
    id: "tactical-genai-trainer", name: "Tactical GenAI Trainer", section: "civilian", sale: "buy", lookupKey: "PLG-TGT-MO", available: false, price: MONTHLY_PRICE, billing: "monthly",
    kicker: "Certification training platform",
    pitch: "Self-paced certification training: 11 curricula and 202 modules across generative AI, cloud architecture, cloud security, and CMMC CUI awareness, with printable contact-hour certificates.",
    lucid: "Will run its scenarios and grading on your LUCID model instead of a Gemini key, so training keeps working on local GPUs with no internet.",
    media: { loop: true, poster: "webp", glyph: "shield", tone: "cyan" },
  },
  {
    // P-PLUGINS.PREMIUM2 (ADR-0699): a monthly subscription per license; several licenses go through a quote.
    id: "lucid-meeting-hub", name: "LUCID Meeting Hub", section: "civilian", sale: "buy", lookupKey: "PLG-MEETHUB-MO", available: false, price: MONTHLY_PRICE,
    billing: "monthly", perLicense: true, quoteUrl: MEETING_HUB_QUOTE_URL,
    kicker: "Private meeting capture",
    pitch: "Meeting capture without a bot in the room: it detects Teams, Zoom, Webex, and Meet calls, transcribes with Whisper, labels speakers, and writes the summary, decisions, and action items into an encrypted local vault.",
    lucid: "Will install the Hub from here. Today it already pairs with LUCID's Meetings panel, where you search past meetings and send notes and screenshots into your knowledge graph.",
    media: { loop: true, poster: "webp", glyph: "calendar", tone: "violet" },
  },
  {
    // ADR-0505: the remote-spokes hub (TechLead187/lucidagentIDEaddon remote-spoke/plugin). Coming soon until a
    // build signed with the TECHLEAD 187 LLC publisher key is uploaded and the entitlements catalog sells
    // PLG-REMOTESPOKES-OTF; until then a private build installs from the Installed tab, shown as unsigned.
    id: "remote-spokes", name: "Remote Agents", section: "civilian", sale: "buy", lookupKey: "PLG-REMOTESPOKES-OTF", available: false, price: APP_PRICE,
    kicker: "LUCID on your other machines",
    pitch: "Drive headless LUCID engines on your VMs, a DGX Spark, or a cloud VM from this IDE through a sealed relay: pair a machine once, hand it tasks, watch its agents, and approve or reject what it asks with a decision that machine's engine verifies.",
    lucid: "A hub that runs on this machine and opens as Remote agents on the left rail. Until the signed release is on sale, a private build installs from the Installed tab and is marked unsigned.",
    media: { loop: false, poster: "generated", glyph: "share", tone: "cyan" },
  },
  // P-WORLDS.STORE1: the Lucid Agent World Packs, listed above everything else on PREMIUM. A pack unlocks worlds on
  // the account (the backend writes or resolves each world's entitlement); it has no package of its own, so its
  // card never installs, opens or updates. Each card plays a collage loop of many worlds.
  {
    id: PATRON_PACK_ID, name: "Patron Class", section: "civilian", group: WORLD_PACKS_GROUP, sale: "buy", lookupKey: "BND-WORLDS-PATRON-OTF", available: true, price: "$99.99",
    kicker: "Lucid Agent World Pack",
    pitch: "Every Lucid Agent World live today, plus every world released in the next 3 years, yours to keep forever. Over 100 worlds are on the roadmap, and 3 years of updates bring improved graphics, mini games and Deluxe upgrades.",
    lucid: "Every world card turns to Install the moment the pack is yours, and each new world unlocks on its own as it is released. Worlds open in the Visualize view.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "amber" },
  },
  {
    id: SPONSOR_PACK_ID, name: "Sponsor", section: "civilian", group: WORLD_PACKS_GROUP, sale: "buy", lookupKey: "BND-WORLDS-SPONSOR-OTF", available: true, price: "$49.99",
    kicker: "Lucid Agent World Pack",
    pitch: "Pick any 6 Lucid Agent Worlds today and bank 6 more world credits to spend on any world, current or future, over the next 3 years. 12 worlds for about the price of 5, plus 3 years of updates on every world you own.",
    lucid: "Choose your 6 worlds before checkout. Later, Use a credit on any world's card unlocks it, and every unlocked world installs and opens in the Visualize view.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "violet" },
  },
  // ADR-0648: Lucid Agent Worlds, add-on packs for the Visualize view. Each brings its own cast (the hub is the boss,
  // agents are the fleet lanes, subagents the helpers), stages, sky, three throwables and a storm. A world installs
  // like any store plugin and opens in Visualize's style picker; it never runs as a program.
  {
    id: "world-christmas", name: "Christmas", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CHRISTMAS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Santa's workshop for your agents: Santa runs it, the elves build, and the reindeer fly the helpers in. Snowy stages, a winter sky, snowball throwables, and a Blizzard storm.",
    lucid: "Turns the Visualize view into the workshop: your main agent is Santa, every fleet lane an elf at a bench, and each subagent arrives by reindeer. Pick it from the Visualize style picker.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "accent" },
  },
  {
    id: "world-valentines", name: "Valentine's Day", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-VALENTINES-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Mount Olympus in love: Cupid and the Greek gods take the stage, with marble temples, a rose sky, heart throwables, and a Heart Storm.",
    lucid: "Your main agent rules from Olympus, the fleet lanes are the gods, and Cupid's helpers are your subagents. Pick it from the Visualize style picker.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "violet" },
  },
  {
    id: "world-football", name: "Football", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FOOTBALL-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Game day: a coach and the team in YOUR colors on a floodlit field, with footballs to throw and a Rain Delay or Hail storm.",
    lucid: "Your main agent is the coach on the sideline, every fleet lane a player, and subagents run on as the special teams. Set the team colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "shield", tone: "blue" },
  },
  {
    id: "world-st-patricks", name: "St. Patrick's Day", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-STPATRICKS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Leprechauns, pots of gold, four-leaf clovers, and rainbows on rolling green hills, with a Rainbow Storm.",
    lucid: "Your main agent is the head leprechaun, the fleet lanes guard their pots of gold, and subagents ride in on rainbows. Pick it from the Visualize style picker.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "green" },
  },
  {
    id: "world-soccer", name: "Soccer", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-SOCCER-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Match day: a manager and a club in YOUR colors under the floodlights, with volleys, yellow cards, a trophy lift and a Flare Storm.",
    lucid: "Your main agent is the manager on the touchline, every fleet lane a player, and subagents run on as assistant coaches and ball kids. Set the club colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "cyan" },
  },
  {
    id: "world-baseball", name: "Baseball", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-BASEBALL-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "A day at the ballpark: a manager and a team in YOUR colors on a sunny diamond, with hot dogs, foam fingers and Fireworks Night.",
    lucid: "Your main agent is the manager in the dugout, every fleet lane a player, and subagents run out as base coaches and bat kids. Set the team colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "record", tone: "blue" },
  },
  {
    id: "world-basketball", name: "Basketball", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-BASKETBALL-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Game night in the arena: a coach and a team in YOUR colors on the hardwood, with the mascot, fresh sneakers and a Blackout Intro.",
    lucid: "Your main agent is the head coach on the sideline, every fleet lane a player, and subagents run on as assistant coaches and the team mascot. Set the team colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bolt", tone: "amber" },
  },
  {
    id: "world-hockey", name: "Hockey", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-HOCKEY-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Puck drop: a coach and a team in YOUR colors on the ice, with hat tricks, an Ice Storm and the red goal light.",
    lucid: "Your main agent is the head coach behind the bench, every fleet lane a skater or goalie, and subagents run on as assistant coaches and the ice resurfacer driver. Set the team colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "shield", tone: "cyan" },
  },
  {
    id: "world-winter-games", name: "Winter Games", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-WINTERGAMES-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The mountain venue: skiers, snowboarders, skaters and curlers in YOUR national colors and flag, with an Avalanche and a gold medal podium.",
    lucid: "Your main agent is the flag bearer, every fleet lane an athlete, and subagents run on as coaches and a polar bear cub mascot. Design the team colors and flag in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "blue" },
  },
  {
    id: "world-summer-games", name: "Summer Games", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-SUMMERGAMES-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The main stadium: sprinters, swimmers, gymnasts and archers in YOUR national colors and flag, with a Heat Wave and a world record on every commit.",
    lucid: "Your main agent is the torchbearer, every fleet lane an athlete, and subagents run on as coaches and judges with scorecards. Design the team colors and flag in the world's options.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "green" },
  },
  {
    id: "world-golf", name: "Golf", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-GOLF-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Tournament day: golfers in YOUR club colors on a sunny course, with caddies, a Links Gale and a hole-in-one on every commit.",
    lucid: "Your main agent is the club pro, every fleet lane a golfer, and subagents run on as course marshals and caddies. Set the club colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "green" },
  },
  {
    id: "world-tennis", name: "Tennis", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-TENNIS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Center court: players in YOUR club colors on grass, clay or hard court, with ball kids, a Dust Devil and a championship ace.",
    lucid: "Your main agent is the coach in the player box, every fleet lane a player, and subagents run on as line judges and ball kids. Pick the court and colors in the world's options.",
    media: { loop: true, poster: "webp", glyph: "record", tone: "violet" },
  },
  {
    id: "world-horse-racing", name: "Horse Racing", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-HORSERACING-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Race day: jockeys on their horses in YOUR racing silks, with the trainer, the bugler, a Hat Flurry and a photo-finish win.",
    lucid: "Your main agent is the trainer, every fleet lane a jockey on a horse, and subagents run on as grooms and the bugler. Register your silks in the world's options.",
    media: { loop: true, poster: "webp", glyph: "gauge", tone: "blue" },
  },
  {
    id: "world-bowling", name: "Bowling", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-BOWLING-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Tournament night: bowlers in YOUR team shirts, with a walking pin mascot, the Pin Avalanche and a STRIKE on every commit.",
    lucid: "Your main agent is the bowling legend, every fleet lane a bowler, and subagents run on as scorekeepers and a walking pin mascot. Pick the shirts, balls, shoes and alley in the world's options.",
    media: { loop: true, poster: "webp", glyph: "record", tone: "blue" },
  },
  {
    id: "world-figure-skating", name: "Figure Skating", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FIGURESKATING-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The championship on ice: skaters in YOUR costume colors, with a Flower Shower and a perfect score on every commit.",
    lucid: "Your main agent is the coach, every fleet lane a figure skater, and subagents run on as judges and flower sweepers. Pick the costumes, sparkle, skates and rink in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "violet" },
  },
  {
    id: "world-extreme-sports", name: "Extreme Sports", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-EXTREMESPORTS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Action sports festival: BMX, skate, dirt bikes and wingsuits in YOUR team kit, with an Air Show and BIG AIR on every commit.",
    lucid: "Your main agent is the hype MC, every fleet lane an action sports athlete, and subagents run on as the DJ and camera operators. Pick the gear, helmets, smoke trails and venue in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bolt", tone: "amber" },
  },
  {
    id: "world-wave-riders", name: "Wave Riders", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-WAVERIDERS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Beach contest: surf, kite, foil and watercraft in YOUR team colors, with a Rogue Wave and a perfect wave on every commit.",
    lucid: "Your main agent is the head judge, every fleet lane a surfer, kitesurfer, foil boarder or watercraft rider, and subagents run on as spotters and lifeguards. Pick the boards, suits, kites and beach in the world's options.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "cyan" },
  },
  {
    id: "world-swim-dive", name: "Swim and Dive", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-SWIMDIVE-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The championship pool: swimmers and divers in YOUR team colors, with the Splash Zone and a gold medal on every commit.",
    lucid: "Your main agent is the head coach, every fleet lane a swimmer or diver, and subagents run on as judges and the rubber-duck mascot. Pick the suits, caps, goggles and pool in the world's options.",
    media: { loop: true, poster: "webp", glyph: "refresh", tone: "blue" },
  },
  {
    id: "world-esports", name: "Esports", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-ESPORTS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Grand finals: pro gamers at RGB setups in YOUR org colors in a neon arena, with a Glitch Storm and a VICTORY on every commit.",
    lucid: "Your main agent is the head coach, every fleet lane a pro gamer, and subagents run on as analysts and broadcast camera operators. Brand your org in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bolt", tone: "violet" },
  },
  {
    id: "world-dog-show", name: "Dog Show", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-DOGSHOW-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Show day: handlers and their poodles, corgis, dalmatians and retrievers in YOUR kennel colors, with Bath Time and Best in Show.",
    lucid: "Your main agent is the judge, every fleet lane a handler showing a dog, and subagents run on as ring stewards and groomers. Set the kennel colors and breeds in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "violet" },
  },
  {
    id: "world-farm", name: "Farm", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FARM-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "A day on the farm: cows, pigs, sheep and goats in YOUR farm colors, with chicks, a Twister and a blue ribbon on every commit.",
    lucid: "Your main agent is the farmer, every fleet lane a farm animal, and subagents run on as farmhands and chicks. Paint the barn, pick the animals and the season in the world's options.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "green" },
  },
  {
    id: "world-talent-show", name: "Talent Show", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-TALENTSHOW-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Live from the big stage: singers, dancers, jugglers and DJs in YOUR show colors, with a Glitter Bomb and a standing ovation.",
    lucid: "Your main agent is the host, every fleet lane a contestant, and subagents run on as judges and stagehands. Style the stage and costumes in the world's options.",
    media: { loop: true, poster: "webp", glyph: "mic", tone: "amber" },
  },
  {
    id: "world-circus", name: "Circus", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CIRCUS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Under the big top: acrobats, jugglers, strongmen and unicyclists in YOUR circus colors, with clowns, the Clown Car and a TA-DA.",
    lucid: "Your main agent is the ringmaster, every fleet lane a performer, and subagents run on as clowns and performing seals. Paint the big top in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "amber" },
  },
  {
    id: "world-magic-show", name: "Magic Show", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-MAGICSHOW-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Curtain up: magicians in YOUR theater colors with white rabbits, Smoke and Mirrors and a grand vanishing act on every commit.",
    lucid: "Your main agent is the grand magician, every fleet lane a magician, and subagents run on as stage assistants and white rabbits. Choose the curtains and sparkle in the world's options.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "violet" },
  },
  {
    id: "world-chef-showdown", name: "Chef Showdown", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CHEFSHOWDOWN-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Service! Cooks on the red team or the blue team in YOUR brigade colors, with a Flambe Frenzy and a signature dish on every commit.",
    lucid: "Your main agent is the head chef judging the pass, every fleet lane a cook at a station, and subagents run on as sous chefs and waiters. Set the team, jackets and kitchen in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bolt", tone: "amber" },
  },
  {
    id: "world-hospital", name: "Hospital", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-HOSPITAL-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Rounds on the ward: surgeons, ER doctors, pediatricians and lab scientists in YOUR hospital colors, with Flu Season and a patient going home healthy.",
    lucid: "Your main agent is the chief of medicine, every fleet lane a doctor, and subagents run on as nurses and interns. Pick the scrubs, coats and ward in the world's options.",
    media: { loop: true, poster: "webp", glyph: "plus", tone: "cyan" },
  },
  {
    id: "world-university", name: "University", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-UNIVERSITY-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Term time on campus: students in YOUR school colors, with the professor, the campus squirrel, Finals Week and a graduation on every commit.",
    lucid: "Your main agent is the professor, every fleet lane a student, and subagents run on as teaching assistants and the campus squirrel. Set the school colors, gowns and campus in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bulb", tone: "amber" },
  },
  {
    id: "world-construction", name: "Construction", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CONSTRUCTION-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "A busy job site: welders, carpenters, bricklayers and electricians in YOUR company colors, with little diggers, the Wrecking Ball and a topping-out.",
    lucid: "Your main agent is the foreman, every fleet lane a tradesperson, and subagents run on as site engineers and little diggers. Pick the hard hats, vests and machines in the world's options.",
    media: { loop: true, poster: "webp", glyph: "toolbox", tone: "amber" },
  },
  {
    id: "world-grand-prix", name: "Grand Prix", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-GRANDPRIX-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Race weekend: drivers and open-wheel race cars in YOUR team livery, with the pit crew, a Burnout and a podium win with champagne.",
    lucid: "Your main agent is the team principal, every fleet lane a driver with a race car, and subagents run on as race engineers and pit crew. Design the livery and helmets in the world's options.",
    media: { loop: true, poster: "webp", glyph: "gauge", tone: "blue" },
  },
  // P-WORLDS.2 (ADR-0679): the service-themed and state worlds, named for the scene they show and never for a branch:
  // no branch names, seals, emblems, mottos or other marks.
  {
    id: "world-field-exercise", name: "Field Exercise", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FIELDEXERCISE-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Field training: infantry, medics, engineers and scouts in YOUR camouflage, with a Sandstorm and a promotion on every commit.",
    lucid: "Your main agent is the battalion commander, every fleet lane a soldier, and subagents run on as staff officers and battle buddies. Pick the camouflage, terrain and unit color in the world's options.",
    media: { loop: true, poster: "webp", glyph: "shield", tone: "green" },
  },
  {
    id: "world-flight-deck", name: "Flight Deck", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FLIGHTDECK-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Flight ops at sea: deck crews in the colored jerseys, with Heavy Seas and a catapult launch on every commit.",
    lucid: "Your main agent is the captain, every fleet lane a flight deck crew member, and subagents run on as deck officers and blue-shirt chock runners. Pick the time of day, dress and sea state in the world's options.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "blue" },
  },
  {
    id: "world-flight-line", name: "Flight Line", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FLIGHTLINE-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The flight line: pilots, crew chiefs, loadmasters and forecasters, with a Thunderstorm and a four-ship flyover in YOUR colors.",
    lucid: "Your main agent is the ops supervisor in the tower, every fleet lane an airman, and subagents run on as tower controllers and maintainers. Pick the flight suits, jet scheme and contrails in the world's options.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "cyan" },
  },
  {
    id: "world-boot-camp", name: "Boot Camp", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-BOOTCAMP-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Recruit training on the coast: obstacle course, drill and surf, with Crucible Night and a graduation on every commit.",
    lucid: "Your main agent is the senior drill instructor, every fleet lane a recruit, and subagents run on as junior drill instructors and fire team members. Pick the camouflage, uniform and course in the world's options.",
    media: { loop: true, poster: "webp", glyph: "bolt", tone: "amber" },
  },
  {
    id: "world-sea-rescue", name: "Sea Rescue", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-SEARESCUE-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "A rescue station under the lighthouse: swimmers, boats and hoists, with a Nor'easter and a helicopter rescue on every commit.",
    lucid: "Your main agent is the station commander, every fleet lane a rescue specialist, and subagents run on as watchstanders and boat crews. Pick the weather, gear color and station in the world's options.",
    media: { loop: true, poster: "webp", glyph: "refresh", tone: "amber" },
  },
  {
    id: "world-orbital-ops", name: "Orbital Ops", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-ORBITALOPS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Orbital ops above the Earth: satellite operators and spacewalkers with drone helpers, a Solar Flare and a launch on every commit.",
    lucid: "Your main agent is the mission director, every fleet lane a station crew member, and subagents fly as little orbital drones. Pick the suits, backdrop and glow in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "violet" },
  },
  {
    id: "world-cyber-ops", name: "Cyber Ops", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CYBEROPS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Network defense on a neon ops floor: defenders, testers and threat hunters with sentinel bots, a DDoS Surge and a patch on every commit.",
    lucid: "Your main agent is the cyber commander, every fleet lane a cyber operator, and subagents float as sentinel bots. Pick the theme color, grid and outfits in the world's options.",
    media: { loop: true, poster: "webp", glyph: "terminal", tone: "green" },
  },
  {
    id: "world-special-operations", name: "Special Operations", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-SPECIALOPERATIONS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Special operations training: jumpers, divers, climbers and scouts, with a Night Op and a HALO drop in YOUR colors.",
    lucid: "Your main agent is the operations commander, every fleet lane an operator, and subagents run on as comms specialists and the support team. Pick the terrain, camouflage and time of day in the world's options.",
    media: { loop: true, poster: "webp", glyph: "scan", tone: "accent" },
  },
  {
    id: "world-florida", name: "Florida", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-FLORIDA-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Florida Man runs the show: the Space Coast, Tampa Bay, Miami and the Everglades, with a Hurricane and a launch on every commit.",
    lucid: "Your main agent is the Florida legend, every fleet lane a local from a different corner of the state, and subagents run on as flamingos and friendly gators. Pick the region, shirts and time of day in the world's options.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "accent" },
  },
  {
    id: "world-texas", name: "Texas", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-TEXAS-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "Big sky ranch country: rodeo riders, roughnecks, pitmasters and pickers, with a Supercell and a rodeo win on every commit.",
    lucid: "Your main agent is the ranch boss, every fleet lane a Texan at work, and subagents run on as ranch hands and rodeo clowns. Pick the region, hats and denim in the world's options.",
    media: { loop: true, poster: "webp", glyph: "star", tone: "amber" },
  },
  {
    id: "world-california", name: "California", section: "civilian", group: WORLDS_GROUP, sale: "buy", lookupKey: "PLG-WORLD-CALIFORNIA-OTF", available: true, price: WORLD_PRICE,
    kicker: "Lucid Agent World",
    pitch: "The Golden State on set: founders, surfers, stunt performers and vintners, with The Big One and a premiere on every commit.",
    lucid: "Your main agent is the film director, every fleet lane a Californian at work, and subagents run on as camera crew and production assistants. Pick the region, hoodies and light in the world's options.",
    media: { loop: true, poster: "webp", glyph: "record", tone: "cyan" },
  },
  {
    id: "leaps", name: "LEAPS", section: "civilian", sale: "link",
    href: "https://l-e-a-p-s-947863229376.us-west1.run.app", linkLabel: "Subscription on leaps",
    kicker: "Spaced repetition studio",
    pitch: "LEAP Study Studio: a cloud-synced flashcard studio on the SM-2 spaced repetition engine, with starter decks for Cisco CCNA, AWS, military planning (MDMP), and more.",
    lucid: "LEAPS is sold as its own subscription. Your decks and progress live on the LEAPS site, which opens in your browser.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "green" },
  },
  {
    id: "rapid-survey", name: "RAPID-SURVEY", section: "government", sale: "buy", lookupKey: "PLG-RAPID-OTF", available: false, price: APP_PRICE,
    kicker: "Offline site intelligence",
    pitch: "Facility survey for security integrators, facilities and AEC teams, insurers, and public safety: on-site AI behind a CUI lockdown switch, native DWG drawings, IFC for Revit, and a one-click Autodesk package.",
    lucid: "Will run its site analysis through your LUCID model, including gov-lockdown routing, so survey data only travels the paths your organization approved.",
    media: { loop: true, poster: "webp", glyph: "scan", tone: "blue" },
  },
  {
    id: "quantum-cloak", name: "Quantum Cloak", section: "government", sale: "buy", lookupKey: "PLG-QCLOAK-OTF", available: true, price: APP_PRICE,
    kicker: "Quantum comms and computing trainer",
    pitch: "38 narrated 3-D modules on real simulators, starting with a math and physics primer: qubits and Bell tests, QKD over fiber and satellites and the attacks on it, Shor and Grover, error correction, the NIST post-quantum standards and migration deadlines, and capstone missions, with practice, track certificates and instructor reports.",
    lucid: "Runs in a Preview tab; only the narration audio streams from Google Cloud Storage. Its tools let the agent simulate circuits, run QKD links and lattice scenarios, quiz you with practice items, and explain any term.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "violet" },
  },
  {
    id: "mdmp-engine", name: "MDMP Engine", section: "government", sale: "link", partner: BLACK_ARROW,
    href: "https://tacticalmdmp.com/", linkLabel: "Visit partner",
    kicker: "Army MDMP trainer",
    pitch: "Turns the seven-step Military Decision-Making Process into a guided digital workflow: real-time doctrinal coaching, automated IPB, MIL-STD-2525D mapping, COA war-gaming, and one-click WARNORD and OPORD production.",
    lucid: "A Black Arrow Systems app built in partnership with TECHLEAD 187 LLC. It runs on tacticalmdmp.com and is not sold through LUCID.",
    media: { loop: true, poster: "webp", glyph: "layout", tone: "amber" },
  },
  {
    id: "joint-planning-engine", name: "Joint Planning Engine", section: "government", sale: "link", partner: BLACK_ARROW,
    href: "https://www.blackarrowsystems.net", linkLabel: "Visit partner",
    kicker: "Joint planning C2",
    pitch: "A secure, collaborative C2 application that guides military staffs through the Joint Planning Process and automates the heavy lifting of JIPOE, COA development, and wargaming.",
    lucid: "A Black Arrow Systems app built in partnership with TECHLEAD 187 LLC. It runs on the partner's site and is not sold through LUCID.",
    media: { loop: true, poster: "webp", glyph: "share", tone: "blue" },
  },
];

/** Closed set. featured = pinned to the top; built-in = LUCID already ships the capability;
 *  planned = on the integration roadmap (ADR-0158); add-on = an optional free add-on this build offers,
 *  installed only when the user presses Install on its card (ADR-0541). */
export type FreeStatus = "featured" | "built-in" | "planned" | "add-on";

/** One line of an add-on's "how to use it" sheet: a command to type and what it does. */
export interface AddonStep { command: string; what: string }

export interface FreePlugin {
  id: string;            // stable id: never regenerated (AGENTS.md invariant 9)
  name: string;
  desc: string;          // one line: what it does
  /** The upstream project (https GitHub). Absent for a LUCID capability with no separate upstream. */
  repo?: string;
  category: string;
  /** Obsidian community downloads where verified; null = unverified (never fabricated). */
  downloads: number | null;
  /** Canonical order: 1 = Excalidraw (pinned), then the Obsidian integrations rank, then LUCID-fit additions. */
  rank: number;
  status: FreeStatus;
  /** The "With LUCID Agent" line. For a planned row it is the integration plan. */
  lucid: string;
  glyph: string;
  tone: PosterTone;
  /** An add-on's sheet after Open: the commands that use it. Only `add-on` rows carry it. */
  howTo?: readonly AddonStep[];
  /** An add-on that serves a read-only page on its runtime port: Open also shows that page in the
   *  add-on's Preview tab, beside the sheet of commands (ADR-0497 as the Herd add-on). */
  page?: boolean;
}

/** The FREE registry (ADR-0158/0181 rows, retired ids never reused: copilot, brat, url-into-selection, readwise). */
export const FREE_PLUGINS: FreePlugin[] = [
  {
    id: "excalidraw", name: "Excalidraw", rank: 1, status: "featured",
    desc: "Virtual whiteboard for sketching hand-drawn-like diagrams.",
    repo: "https://github.com/excalidraw/excalidraw",
    category: "Whiteboard", downloads: 6_487_654, glyph: "pen", tone: "violet",
    lucid: "Embed the whiteboard in the sandboxed Preview panel; sketches feed the agent as design context.",
  },
  {
    id: "git", name: "Git", rank: 2, status: "built-in",
    desc: "Version your workspace with git, run safely on the host.",
    category: "Version control", downloads: null, glyph: "git", tone: "amber",
    lucid: "The agent's git runs through a host broker with an allowlist of subcommands and options, and the commit gate stops one agent from sweeping another agent's uncommitted files into its commit.",
  },
  {
    id: "remotely-save", name: "Remotely Save", rank: 3, status: "planned",
    desc: "Sync notes and settings to S3, WebDAV, Dropbox or OneDrive.",
    repo: "https://github.com/remotely-save/remotely-save",
    category: "Sync", downloads: 2_008_001, glyph: "refresh", tone: "blue",
    lucid: "Encrypted sync of sessions and semantic memory to storage you own (S3, WebDAV), with keys held in the vault.",
  },
  {
    id: "importer", name: "Importer", rank: 4, status: "planned",
    desc: "Import notes from Notion, Evernote, Roam, Apple Notes and more.",
    repo: "https://github.com/obsidianmd/obsidian-importer",
    category: "Import", downloads: null, glyph: "download", tone: "cyan",
    lucid: "Import external notes and docs into the knowledge graph through the scanner gate, labeled untrusted.",
  },
  {
    id: "advanced-uri", name: "Advanced URI", rank: 5, status: "planned",
    desc: "Deep links to control the app from outside (open, search, write).",
    repo: "https://github.com/Vinzent03/obsidian-advanced-uri",
    category: "Automation", downloads: null, glyph: "link", tone: "accent",
    lucid: "lucid:// deep links to open a session, run a slash command, or launch a saved agent.",
  },
  {
    id: "zotero", name: "Zotero Integration", rank: 6, status: "planned",
    desc: "Insert citations, notes and annotations from Zotero.",
    repo: "https://github.com/mgmeyers/obsidian-zotero-integration",
    category: "Research", downloads: null, glyph: "report", tone: "amber",
    lucid: "Pull citations and annotations into chat and the knowledge graph for research-heavy work.",
  },
  {
    id: "languagetool", name: "LanguageTool", rank: 7, status: "planned",
    desc: "Grammar and style checking for your prose.",
    repo: "https://github.com/Clemens-E/obsidian-languagetool-plugin",
    category: "Writing", downloads: null, glyph: "textT", tone: "green",
    lucid: "A grammar pass over drafted docs and briefs through a self-hosted LanguageTool endpoint, no cloud by default.",
  },
  {
    id: "mermaid", name: "Mermaid", rank: 8, status: "planned",
    desc: "Diagrams as code: flowcharts, sequence and architecture diagrams from plain text.",
    repo: "https://github.com/mermaid-js/mermaid",
    category: "Diagrams", downloads: null, glyph: "graph", tone: "cyan",
    lucid: "Render the agent's mermaid blocks inline in chat and the sandboxed Preview panel, offline, with no execution.",
  },
  {
    id: "gitleaks", name: "Gitleaks", rank: 9, status: "planned",
    desc: "Scan repos and commits for hardcoded secrets and credentials.",
    repo: "https://github.com/gitleaks/gitleaks",
    category: "Security", downloads: null, glyph: "shield", tone: "accent",
    lucid: "A pre-commit secret sweep wired into the exec gate; findings land as security events beside the vault.",
  },
  {
    id: "semgrep", name: "Semgrep", rank: 10, status: "planned",
    desc: "Fast static analysis with community security rules.",
    repo: "https://github.com/semgrep/semgrep",
    category: "Security", downloads: null, glyph: "scan", tone: "blue",
    lucid: "A static-analysis pass over agent-written code; findings surface in the security feed before anything ships.",
  },
  {
    id: "trivy", name: "Trivy", rank: 11, status: "planned",
    desc: "Vulnerability and misconfiguration scanner for dependencies, containers and IaC.",
    repo: "https://github.com/aquasecurity/trivy",
    category: "Security", downloads: null, glyph: "search", tone: "green",
    lucid: "On-demand dependency and SBOM scans; evidence exports beside the OCSF audit trail for CMMC and RMF packages.",
  },
  {
    id: "pandoc", name: "Pandoc", rank: 12, status: "planned",
    desc: "Universal document converter: markdown to DOCX, PDF, HTML and more.",
    repo: "https://github.com/jgm/pandoc",
    category: "Documents", downloads: null, glyph: "print", tone: "violet",
    lucid: "Export briefs, ADRs and reports to DOCX and PDF fully offline, for air-gapped deliverables.",
  },
  {
    id: "obsidian", name: "Obsidian", rank: 13, status: "built-in",
    desc: "Bring an Obsidian-style markdown vault into LUCID.",
    category: "Knowledge", downloads: null, glyph: "brain", tone: "violet",
    lucid: "Point the Knowledge panel at a vault folder; its notes compile into a named knowledge graph the agent answers from.",
  },
  {
    id: "browser", name: "Browser", rank: 14, status: "built-in",
    desc: "A real Chromium window the agent drives where you can watch it.",
    category: "Web", downloads: null, glyph: "eye", tone: "cyan",
    lucid: "The agent opens pages, clicks, types, and reads snapshots in a visible window. Closing the window is a kill switch for every pending command.",
  },
  {
    id: "codegraph", name: "Codegraph", rank: 15, status: "built-in",
    desc: "Turn the current workspace into an explorable code graph.",
    category: "Code intelligence", downloads: null, glyph: "runs", tone: "amber",
    lucid: "Ingest the workspace at the depth you pick, then explore symbols and their links yourself or let the agent use the graph.",
  },
  {
    id: "openfilm", name: "OpenFilm", rank: 16, status: "built-in",
    desc: "An HTML film format and CLI: pages that draw each frame, rendered to video.",
    repo: "https://github.com/openfilm/openfilm",
    category: "Video", downloads: null, glyph: "layout", tone: "accent",
    lucid: "Creator Studio checks a film for frames that do not repeat, page errors, and cut-off text, then renders it with headless Chromium and FFmpeg.",
  },
  {
    id: "whisper", name: "Whisper", rank: 17, status: "built-in",
    desc: "Speech-to-text on your own machine with whisper.cpp.",
    repo: "https://github.com/ggml-org/whisper.cpp",
    category: "Speech", downloads: null, glyph: "mic", tone: "green",
    lucid: "Dictate to the agent from the composer mic. With Local Whisper started in Settings, Voice, the bundled whisper.cpp server transcribes on this machine.",
  },
  {
    id: "knowledge-graph", name: "Knowledge Graph", rank: 18, status: "built-in",
    desc: "Named knowledge graphs from your chats, documents, and vaults.",
    category: "Knowledge", downloads: null, glyph: "graph", tone: "blue",
    lucid: "Seed graphs from ChatGPT, Claude, or Gemini exports or markdown, import signed Role KG Packs, and ground the agent's answers in them.",
  },
  {
    // ADR-0541: P-HERD ships as this optional add-on. The classic `lucid hub` stays the default; nothing of Herd
    // installs or runs until the user presses Install here.
    id: "herd", name: "Herd", rank: 19, status: "add-on",
    desc: "See and run your agents from a terminal window. Your boards keep running when you close the window.",
    category: "Terminal", downloads: null, glyph: "terminal", tone: "cyan",
    lucid: "Type lucid herd in any terminal to see your agents and their boards. Close the window and the boards keep running; open it again later and pick up where you left off. You can keep more than one set of boards, each with its own name. Open shows a live view of your main boards here. The classic terminal view stays as it is.",
    page: true,
    howTo: [
      { command: "lucid herd", what: "Show your main boards, or start them if they are not running." },
      { command: "lucid herd --name work", what: "Show a second set of boards named work." },
      { command: "lucid herd server list", what: "List the sets of boards that are running." },
      { command: "lucid herd server stop", what: "Stop the boards. Pressing Q in the terminal only closes the window; the boards keep running." },
    ],
  },
];

/** Featured pinned first, then rank asc, name as tiebreak. Pure; the input is not mutated. */
export function sortFree(list: FreePlugin[]): FreePlugin[] {
  return [...list].sort((a, b) =>
    Number(b.status === "featured") - Number(a.status === "featured") || a.rank - b.rank || a.name.localeCompare(b.name));
}

/** Case-insensitive substring filter over every line a card shows. Blank query keeps everything. Pure. */
export function matchesQuery(fields: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f.toLowerCase().includes(q));
}

/** 6_487_654 -> "6.5M", 412_000 -> "412K", null -> "". Pure. */
export function fmtDownloads(n: number | null): string {
  if (n == null || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

/** The drawer's tabs: the two catalog tiers, and INSTALLED (ADR-0505), what is on this machine. */
export type DrawerTab = PluginTier | "installed";

/** A drawer tab from a tab button's `data-plg-tier` (ADR-0461/0505); anything else reads as PREMIUM, the tab every
 *  open lands on (P-PLUGINS.PREMIUM2, ADR-0699). */
export function parseTierPref(raw: string | null | undefined): DrawerTab {
  return raw === "free" || raw === "installed" ? raw : "premium";
}

/** What an installed package says about where it came from (the engine's `GET /api/plugins` row). */
export interface InstalledFacts { id: string; version: string; source: "catalog" | "private"; signed: boolean }

/** The version a store card counts as installed: only a store install. A private copy under a store id is
 *  not the purchased package, so the card neither opens it nor offers to update it (ADR-0505). Pure. */
export function storeInstalledVersion(p: InstalledFacts | null | undefined): string | null {
  return p && p.source === "catalog" ? p.version : null;
}

/** The provenance chip on an Installed row. A private unsigned package always says so. Pure. */
export function provenanceChip(p: InstalledFacts): { tone: "ok" | "warn"; label: string } {
  if (p.source === "catalog") return { tone: "ok", label: "LUCID store" };
  return p.signed ? { tone: "ok", label: "Private, signed by TECHLEAD 187 LLC" } : { tone: "warn", label: "Private, unsigned" };
}

/** Plain-language reasons for each install gate (ADR-0462), so a refusal says what failed. */
export const GATE_TEXT: Record<PluginGate, string> = {
  manifest: "The package manifest is not valid",
  hash: "A file in the package does not match its recorded checksum",
  signature: "The package is not signed by a trusted publisher",
  authenticode: "A program in the package is not signed by TECHLEAD 187 LLC",
  scan: "The security scan stopped the package",
  download: "The package could not be downloaded",
  private: "This package cannot be installed from a file",
};

/** Is `candidate` a strictly newer release than `installed`? Numeric `major.minor.patch`, where a prerelease
 *  (`1.2.0-beta.1`) sorts below its release. An unparseable side is never "newer": a garbled version must not
 *  nag the user into an update that may not exist. */
export function isNewerVersion(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec((v ?? "").trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" } : null;
  };
  const a = parse(candidate), b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;  // 1.2.0 > 1.2.0-beta
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

/** What a premium card's one button does right now. */
export type CardAction =
  | { kind: "visit"; url: string; label: string }
  | { kind: "coming-soon" }
  | { kind: "signin" }
  | { kind: "request-access"; declined: boolean }
  | { kind: "access-pending" }
  | { kind: "buy"; price: string }
  | { kind: "install" }
  | { kind: "installing" }
  | { kind: "open" }
  /** An installed Lucid Agent World: it opens in the Visualize view, never as a program (ADR-0648). */
  | { kind: "open-world" }
  | { kind: "update"; to: string }
  /** P-WORLDS.STORE1: an owned world pack. Terminal: a pack has no package, so it never installs, opens or
   *  updates. `credits` is the Sponsor pack's unspent world credits; null for Patron Class. */
  | { kind: "owned"; credits: number | null }
  /** P-WORLDS.STORE1: a world not owned yet, while the Sponsor pack still has a live credit to unlock it. */
  | { kind: "redeem" };

/** Is this card a Lucid Agent World (ADR-0648)? */
export function isWorldPlugin(p: PremiumPlugin): boolean { return p.group === WORLDS_GROUP; }

/** Is this card a Lucid Agent World Pack (P-WORLDS.STORE1)? */
export function isBundle(p: PremiumPlugin): boolean { return p.group === WORLD_PACKS_GROUP; }

/** The Sponsor pack's spendable world credits right now: 0 unless the pack itself is entitled and its credits
 *  have not lapsed (`creditsUntil` in the past). Fail-closed like isEntitled: a missing count is 0. Pure. */
export function sponsorCredits(ent: Entitlement | null | undefined, nowIso: string): number {
  if (!isEntitled(ent, nowIso)) return 0;
  if (ent?.creditsUntil && ent.creditsUntil <= nowIso) return 0;
  const n = ent?.creditsRemaining;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface CardFacts {
  signedIn: boolean;
  /** The backend's (user, plugin) entitlement; `premium-all` is resolved server-side into this record. */
  entitlement: Entitlement | null;
  /** P-WORLDS.STORE1: the Sponsor pack's entitlement (its credits can unlock a world). Absent reads as none. */
  sponsor?: Entitlement | null;
  gov: GovAccessStatus;
  /** Version of the locally installed package, or null when it is not installed. */
  installedVersion: string | null;
  /** A download or install for this card is in flight. */
  busy: boolean;
  nowIso: string;
}

/** The card state machine (ADR-0461/0463/0465). Order matters:
 *  1. A link-out only ever visits: it is never sold, so no fact can turn it into Buy.
 *     A sold plugin whose package is not available yet is Coming soon: nothing to buy, request, or install.
 *  2. In-flight work shows Installing.
 *  3. An installed plugin opens (it runs offline and never phones home; a world opens in Visualize), or offers Update when the user is
 *     still entitled and the backend has published a newer version.
 *  4. Otherwise the fail-closed pack decision: signed out -> signin; entitled -> install; else checkout,
 *     where a Government plugin buys ONLY with approved access and otherwise asks for it, and a world the
 *     Sponsor pack can still unlock offers its credit instead of Buy (P-WORLDS.STORE1).
 *  A world pack (P-WORLDS.STORE1) has no package: after 1 it is only ever signin, buy, or the terminal owned. */
export function decideCardAction(p: PremiumPlugin, f: CardFacts): CardAction {
  if (p.sale === "link") return { kind: "visit", url: p.href, label: p.linkLabel };
  if (!p.available) return { kind: "coming-soon" };
  if (isBundle(p)) {
    const pack = decidePackAction({ signedIn: f.signedIn }, f.entitlement, f.nowIso);
    if (pack === "signin") return { kind: "signin" };
    if (pack === "pull") return { kind: "owned", credits: p.id === SPONSOR_PACK_ID ? sponsorCredits(f.entitlement, f.nowIso) : null };
    return { kind: "buy", price: p.price };
  }
  if (f.busy) return { kind: "installing" };
  const decision = decidePackAction({ signedIn: f.signedIn }, f.entitlement, f.nowIso);
  if (f.installedVersion) {
    const latest = f.entitlement?.latestVersion;
    if (decision === "pull" && latest && isNewerVersion(latest, f.installedVersion)) return { kind: "update", to: latest };
    return isWorldPlugin(p) ? { kind: "open-world" } : { kind: "open" };
  }
  if (decision === "signin") return { kind: "signin" };
  if (decision === "pull") return { kind: "install" };
  if (p.section === "government" && f.gov !== "approved") {
    return f.gov === "pending" ? { kind: "access-pending" } : { kind: "request-access", declined: f.gov === "declined" };
  }
  if (isWorldPlugin(p) && sponsorCredits(f.sponsor, f.nowIso) > 0) return { kind: "redeem" };
  return { kind: "buy", price: p.price };
}

/** The button text for each state. One short line (invariant 11). */
export function cardActionLabel(a: CardAction): string {
  switch (a.kind) {
    case "visit": return a.label;
    case "coming-soon": return "Coming soon";
    case "signin": return "Sign in to buy";
    case "request-access": return a.declined ? "Request again" : "Request access";
    case "access-pending": return "Access pending";
    case "buy": return `Buy ${a.price}`;
    case "install": return "Install";
    case "installing": return "Installing";
    case "open": return "Open";
    case "open-world": return "Open in Visualize";
    case "update": return `Update to ${a.to}`;
    case "owned": return "Owned";
    case "redeem": return "Use a credit";
  }
}

/** The foot meta of an owned world pack: what it still gives. One short line (invariant 11). */
export function ownedPackMeta(a: Extract<CardAction, { kind: "owned" }>): string {
  if (a.credits === null) return "Every world unlocked";
  if (a.credits === 0) return "No world credits left";
  return `${a.credits} world ${a.credits === 1 ? "credit" : "credits"} left`;
}

/** What an optional add-on's card offers right now (ADR-0541). `open` also shows Remove beside it. */
export type AddonAction =
  | { kind: "checking" }
  | { kind: "not-offered" }
  | { kind: "install"; version: string }
  | { kind: "installing" }
  | { kind: "open" }
  | { kind: "update"; from: string; to: string };

export interface AddonFacts {
  /** The engine's plugin list has answered at least once, so `offeredVersion` is known. */
  listed: boolean;
  /** The version this build offers (its add-ons index), or null when the build ships none. */
  offeredVersion: string | null;
  /** The installed package (any source), or null when it is not installed. */
  installed: InstalledFacts | null;
  /** An install for this card is in flight. */
  busy: boolean;
}

/** The add-on card's state (ADR-0541, ADR-0563). Order matters: in-flight work shows Installing; an
 *  installed add-on offers Update when this build ships a strictly newer package (installed through the
 *  same install-offered path), else opens (and can be removed) whatever this build offers; otherwise
 *  Install only when this build ships the signed package, and Not in this build when it does not.
 *  Before the first answer, Checking. */
export function decideAddonAction(f: AddonFacts): AddonAction {
  if (f.busy) return { kind: "installing" };
  if (f.installed) {
    const offered = f.offeredVersion;
    return offered && isNewerVersion(offered, f.installed.version)
      ? { kind: "update", from: f.installed.version, to: offered }
      : { kind: "open" };
  }
  if (!f.listed) return { kind: "checking" };
  return f.offeredVersion ? { kind: "install", version: f.offeredVersion } : { kind: "not-offered" };
}

/** The add-on button text. One short line (invariant 11). */
export function addonActionLabel(a: AddonAction): string {
  switch (a.kind) {
    case "checking": return "Checking";
    case "not-offered": return "Not in this build";
    case "install": return "Install";
    case "installing": return "Installing";
    case "open": return "Open";
    case "update": return "Update";
  }
}

/** Split the single "CAGE or UEI" field. A CAGE code is 5 alphanumerics, a UEI is 12; blank is allowed (a
 *  verified .gov/.mil email needs neither). Anything else is an error the form shows inline. */
export function parseCageOrUei(raw: string): { cage?: string; uei?: string } | { error: string } {
  const v = raw.trim().toUpperCase();
  if (!v) return {};
  if (/^[A-Z0-9]{5}$/.test(v)) return { cage: v };
  if (/^[A-Z0-9]{12}$/.test(v)) return { uei: v };
  return { error: "Enter a 5-character CAGE code or a 12-character UEI." };
}
