// Shared chat and in-match sticker catalogue. Pure ESM, usable by server and browser.
import { EMOTE_CATALOG } from './constants.js';

// Existing mode art is shipped by the game, including its animated files.
const MODE_EMOTE_MEDIA = Object.fromEntries([
  ['pic_amiya', 'gif', 1394707, 'pic_amiya.animated-20261102.gif'], ['pic_baoli', 'png', 19650],
  ['pic_dante', 'png', 314147], ['pic_guzhenxing', 'gif', 2074824],
  ['pic_ice', 'png', 413770], ['pic_ksk', 'png', 383004],
  ['pic_lesgo', 'png', 25051], ['pic_naiwa', 'png', 23550],
  ['pic_naochi', 'gif', 1778239], ['pic_nopang', 'png', 273251],
  ['pic_qieqiang', 'png', 195423], ['pic_tan', 'png', 79713],
  ['pic_win', 'png', 271794], ['pic_yiqifengfa', 'png', 250392],
].map(([picId, extension, bytes, filename = `${picId}.${extension}`]) => [picId, {
  src: `/assets/local/emoticon/sifeng/${filename}`,
  bytes, type: extension === 'gif' ? 'image/gif' : 'image/png',
}]));

const MODE_EMOTES = [
  {
    "id": "sifeng_win",
    "sortId": 901,
    "picId": "pic_win",
    "label": "会赢的",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_ice",
    "sortId": 902,
    "picId": "pic_ice",
    "label": "冰冰冰",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_ksk",
    "sortId": 903,
    "picId": "pic_ksk",
    "label": "kskblzdjd",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_nopang",
    "sortId": 904,
    "picId": "pic_nopang",
    "label": "没胖",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_amiya",
    "sortId": 905,
    "picId": "pic_amiya",
    "label": "只有两岁",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_naiwa",
    "sortId": 906,
    "picId": "pic_naiwa",
    "label": "奶蛙",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_dante",
    "sortId": 907,
    "picId": "pic_dante",
    "label": "但丁真是",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_lesgo",
    "sortId": 908,
    "picId": "pic_lesgo",
    "label": "来次够",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_baoli",
    "sortId": 909,
    "picId": "pic_baoli",
    "label": "暴力",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_tan",
    "sortId": 910,
    "picId": "pic_tan",
    "label": "叹",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_naochi",
    "sortId": 911,
    "picId": "pic_naochi",
    "label": "闹吃",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_guzhenxing",
    "sortId": 912,
    "picId": "pic_guzhenxing",
    "label": "古振兴",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_qieqiang",
    "sortId": 913,
    "picId": "pic_qieqiang",
    "label": "31切枪",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  },
  {
    "id": "sifeng_yiqifengfa",
    "sortId": 914,
    "picId": "pic_yiqifengfa",
    "label": "意气风发",
    "dir": "sifeng",
    "themeId": "emoticon_sifeng"
  }
].map(row => Object.freeze(row));
const CUSTOM_STICKERS = [
  {
    "id": "sticker.piior.055390c5a9576e722606391fb82d3aba",
    "label": "piior 1",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/055390c5a9576e722606391fb82d3aba.jpg",
    "bytes": 117115,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.2d174824011174aff0a3585eb9ba2033",
    "label": "piior 2",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/2d174824011174aff0a3585eb9ba2033.jpg",
    "bytes": 26684,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.39cc124618a397905d0331bac964bab9",
    "label": "piior 3",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/39cc124618a397905d0331bac964bab9.jpg",
    "bytes": 17980,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.43302f4af077de3001cbddbe198486e2",
    "label": "piior 4",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/43302f4af077de3001cbddbe198486e2.jpg",
    "bytes": 7873,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.642bf77fca7654ff8750a0a021245ccf",
    "label": "piior 5",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/642bf77fca7654ff8750a0a021245ccf.jpg",
    "bytes": 283254,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.655aa7fc35683a1d8f2db5aebb6c6b14",
    "label": "piior 6",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/655aa7fc35683a1d8f2db5aebb6c6b14.jpg",
    "bytes": 9109,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.80ca000de3b4877189f644392ceedb5d",
    "label": "piior 7",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/80ca000de3b4877189f644392ceedb5d.jpg",
    "bytes": 18872,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.piior.a16a277b4b621b2b90ce98cf4dc12a6f",
    "label": "piior 8",
    "group": "piior",
    "builtin": false,
    "src": "/assets/chat-stickers/piior/a16a277b4b621b2b90ce98cf4dc12a6f.jpg",
    "bytes": 19940,
    "type": "image/jpeg"
  },
  {
    "id": "sticker.tenor.tenor-10307832085527542062",
    "label": "tenor 1",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-10307832085527542062.gif",
    "bytes": 485750,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-10336806993615809019",
    "label": "tenor 2",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-10336806993615809019.gif",
    "bytes": 385518,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-1115242770197379648",
    "label": "tenor 3",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-1115242770197379648.gif",
    "bytes": 208632,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-11301934168281592128",
    "label": "tenor 4",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-11301934168281592128.gif",
    "bytes": 1329899,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-11611869258869574111",
    "label": "tenor 5",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-11611869258869574111.gif",
    "bytes": 454686,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-11893905683071301421",
    "label": "tenor 6",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-11893905683071301421.gif",
    "bytes": 344865,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-12163275330078387139",
    "label": "tenor 7",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-12163275330078387139.gif",
    "bytes": 456051,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-12182449329414173350",
    "label": "tenor 8",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-12182449329414173350.gif",
    "bytes": 421892,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-12230995990157223108",
    "label": "tenor 9",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-12230995990157223108.gif",
    "bytes": 642359,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-12571071056116170529",
    "label": "tenor 10",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-12571071056116170529.gif",
    "bytes": 474363,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-1279811356687533204",
    "label": "tenor 11",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-1279811356687533204.gif",
    "bytes": 188245,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-13001597348061435099",
    "label": "tenor 12",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-13001597348061435099.gif",
    "bytes": 169188,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-13229033282491247567",
    "label": "tenor 13",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-13229033282491247567.gif",
    "bytes": 371460,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-13368642715983264370",
    "label": "tenor 14",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-13368642715983264370.gif",
    "bytes": 795969,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-13514475702505593438",
    "label": "tenor 15",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-13514475702505593438.gif",
    "bytes": 32774,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-14071208532055380074",
    "label": "tenor 16",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-14071208532055380074.gif",
    "bytes": 246292,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-1422001196691993675",
    "label": "tenor 17",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-1422001196691993675.gif",
    "bytes": 146597,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-1442527314200387405",
    "label": "tenor 18",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-1442527314200387405.gif",
    "bytes": 468543,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-15257947972003104964",
    "label": "tenor 19",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-15257947972003104964.gif",
    "bytes": 922363,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-16224184876923864596",
    "label": "tenor 20",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-16224184876923864596.gif",
    "bytes": 600504,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-17524763501510033842",
    "label": "tenor 21",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-17524763501510033842.gif",
    "bytes": 214365,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-301600659032968122",
    "label": "tenor 22",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-301600659032968122.gif",
    "bytes": 486325,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-3502433576639785023",
    "label": "tenor 23",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-3502433576639785023.gif",
    "bytes": 653845,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-3654132533309017047",
    "label": "tenor 24",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-3654132533309017047.gif",
    "bytes": 178258,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-4817560711276484923",
    "label": "tenor 25",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-4817560711276484923.gif",
    "bytes": 185585,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-4934882651703129178",
    "label": "tenor 26",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-4934882651703129178.gif",
    "bytes": 471145,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-5263937160056874921",
    "label": "tenor 27",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-5263937160056874921.gif",
    "bytes": 65140,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-6185077648593896562",
    "label": "tenor 28",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-6185077648593896562.gif",
    "bytes": 63432,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-6346082485097735735",
    "label": "tenor 29",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-6346082485097735735.gif",
    "bytes": 547787,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-649413829682882746",
    "label": "tenor 30",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-649413829682882746.gif",
    "bytes": 493366,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-667429271305568540",
    "label": "tenor 31",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-667429271305568540.gif",
    "bytes": 460402,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-9385567076444465650",
    "label": "tenor 32",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-9385567076444465650.gif",
    "bytes": 356556,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-946815975499007034",
    "label": "tenor 33",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-946815975499007034.gif",
    "bytes": 324282,
    "type": "image/gif"
  },
  {
    "id": "sticker.tenor.tenor-9590276742650048477",
    "label": "tenor 34",
    "group": "tenor",
    "builtin": false,
    "src": "/assets/chat-stickers/tenor/tenor-9590276742650048477.gif",
    "bytes": 84186,
    "type": "image/gif"
  }
].map(row => Object.freeze({ ...row, group: 'personal',
  label: row.label.replace(/^piior\s*/, '表情 ').replace(/^tenor\s*/, '动态表情 ') }));
const builtins = [...new Map([...EMOTE_CATALOG, ...MODE_EMOTES].map(emote => [emote.id, emote])).values()]
  .map(emote => Object.freeze({ id: emote.id, label: emote.label, group: 'official', builtin: true,
    artFamily: `emoticon/${emote.dir}`, picId: emote.picId,
    ...(emote.dir === 'sifeng' ? MODE_EMOTE_MEDIA[emote.picId] : {}), emote }));
const official = Object.freeze(builtins);
const personal = Object.freeze([...CUSTOM_STICKERS]);

export const CHAT_STICKER_GROUPS = Object.freeze([
  Object.freeze({ id: 'official', label: '官方', stickers: official }),
  Object.freeze({ id: 'personal', label: '个性化', stickers: personal }),
]);
export const CHAT_STICKERS = Object.freeze(CHAT_STICKER_GROUPS.flatMap(group => group.stickers));
// In-match grouping is presentation-only: builtin controls resource loading, not catalogue membership.
// Keep the original official set together and include every later sticker exactly once in personal.
const originalEmoteIds = new Set(EMOTE_CATALOG.map(emote => emote.id));
export const IN_MATCH_STICKER_GROUPS = Object.freeze([
  Object.freeze({ id: 'official', label: '官方', stickers: Object.freeze(CHAT_STICKERS.filter(sticker => originalEmoteIds.has(sticker.id))) }),
  Object.freeze({ id: 'personal', label: '个性化', stickers: Object.freeze(CHAT_STICKERS.filter(sticker => !originalEmoteIds.has(sticker.id))) }),
]);
const byId = new Map(CHAT_STICKERS.map(sticker => [sticker.id, sticker]));
export const getChatSticker = id => typeof id === 'string' ? byId.get(id) : undefined;
export const isChatStickerId = id => typeof id === 'string' && byId.has(id);
export const isGameEmoteId = isChatStickerId;

// Named optional stickers are available only after explicit preload or pack import.
export const CHAT_STICKER_RESOURCES = Object.freeze(CUSTOM_STICKERS.map(sticker => Object.freeze({
  url: sticker.src, version: 'chat-stickers-20261102:' + sticker.id,
  bytes: sticker.bytes, type: sticker.type, preloadOnly: true,
})));

// Retain the existing mode emotes alongside essential game art, independent of the old mirror index.
export const GAME_EMOTE_RESOURCES = Object.freeze(builtins.filter(sticker => sticker.src).map(sticker => Object.freeze({
  url: sticker.src, version: 'game-emotes-20261102:' + sticker.id,
  bytes: sticker.bytes, type: sticker.type, selfHosted: true,
})));
