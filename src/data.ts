import { assetUrl } from "./paths";
import {
  SEASON_CATALOG,
  SEASON_RELATED,
  SEASON_SPELL_CATALOG,
  SEASON_HEROES,
} from "./season/catalog";
export type Tribe =
  | "野兽"
  | "机械"
  | "鱼人"
  | "恶魔"
  | "龙"
  | "元素"
  | "纳迦"
  | "海盗"
  | "野猪人"
  | "亡灵"
  | "无"
  | "全部";
export type Keyword =
  "嘲讽" | "圣盾" | "复生" | "剧毒" | "风怒" | "烈毒" | "潜行";
export interface Ability {
  event: string;
  op: string;
  attack?: number;
  health?: number;
  target?: string;
  tribe?: string;
  amount?: number;
  id?: string;
  key?: string;
  keyword?: Keyword;
  tier?: number;
  cost?: number;
  noScale?: boolean;
  highest?: boolean;
  keywords?: boolean;
  magnetic?: boolean;
  permanent?: boolean;
  toggle?: boolean;
}
export interface CardDef {
  sourceId?: string;
  cost?: number;
  kind?: "minion" | "spell";
  season?: boolean;
  playable?: boolean;
  races?: Tribe[];
  goldenText?: string;
  goldenAttack?: number;
  goldenHealth?: number;
  mechanics?: string[];
  abilities?: Ability[];
  magnetic?: boolean;
  activateCost?: number;
  id: string;
  name: string;
  tier: number;
  attack: number;
  health: number;
  tribe: Tribe;
  text: string;
  effect?: string;
  keywords?: Keyword[];
  token?: boolean;
}
export const CARDS: CardDef[] = [
  {
    id: "CFM_315",
    name: "雄斑虎",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "野兽",
    text: "战吼：召唤一头1/1的雌斑虎。",
    effect: "cat",
  },
  {
    id: "EX1_506",
    name: "鱼人猎潮者",
    tier: 1,
    attack: 2,
    health: 1,
    tribe: "鱼人",
    text: "战吼：召唤一个1/1的鱼人斥候。",
    effect: "scout",
  },
  {
    id: "EX1_509",
    name: "鱼人招潮者",
    tier: 1,
    attack: 1,
    health: 2,
    tribe: "鱼人",
    text: "每当你召唤一个鱼人，便获得+1攻击力。",
    effect: "tidecaller",
  },
  {
    id: "BOT_445",
    name: "机械袋鼠",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "机械",
    text: "亡语：召唤一个1/1的机械袋鼠宝宝。",
    effect: "kangaroo",
  },
  {
    id: "BGS_004",
    name: "愤怒编织者",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "无",
    text: "在你使用一张恶魔牌后，对你的英雄造成1点伤害并获得+2/+2。",
    effect: "weaver",
  },
  {
    id: "OG_221",
    name: "无私的英雄",
    tier: 1,
    attack: 2,
    health: 1,
    tribe: "无",
    text: "亡语：随机使一个友方随从获得圣盾。",
    effect: "selfless",
  },
  {
    id: "UNG_073",
    name: "石塘猎人",
    tier: 1,
    attack: 2,
    health: 3,
    tribe: "鱼人",
    text: "战吼：使一个友方鱼人获得+1/+1。",
    effect: "rockpool",
  },
  {
    id: "OG_256",
    name: "恩佐斯的子嗣",
    tier: 2,
    attack: 2,
    health: 2,
    tribe: "无",
    text: "亡语：使你的所有随从获得+1/+1。",
    effect: "spawn",
  },
  {
    id: "KAR_005",
    name: "慈祥的外婆",
    tier: 2,
    attack: 1,
    health: 1,
    tribe: "野兽",
    text: "亡语：召唤一只3/2的大灰狼。",
    effect: "grandmother",
  },
  {
    id: "GVG_048",
    name: "金刚刃牙兽",
    tier: 2,
    attack: 3,
    health: 3,
    tribe: "机械",
    text: "战吼：使你的其他机械获得+2攻击力。",
    effect: "metaltooth",
  },
  {
    id: "BOT_283",
    name: "蹦蹦兔",
    tier: 2,
    attack: 1,
    health: 1,
    tribe: "机械",
    text: "战吼：在本局对战中，你每使用过一张其他蹦蹦兔，便获得+2/+2。",
    effect: "pogo",
  },
  {
    id: "EX1_531",
    name: "食腐土狼",
    tier: 2,
    attack: 2,
    health: 2,
    tribe: "野兽",
    text: "每当一个友方野兽死亡，便获得+2/+1。",
    effect: "hyena",
  },
  {
    id: "EX1_103",
    name: "寒光先知",
    tier: 3,
    attack: 2,
    health: 3,
    tribe: "鱼人",
    text: "战吼：使你的其他鱼人获得+2生命值。",
    effect: "coldlight",
  },
  {
    id: "GVG_062",
    name: "钴制卫士",
    tier: 3,
    attack: 6,
    health: 3,
    tribe: "机械",
    text: "每当你召唤一个机械，便获得圣盾。",
    effect: "cobalt",
  },
  {
    id: "OG_216",
    name: "寄生恶狼",
    tier: 3,
    attack: 3,
    health: 3,
    tribe: "野兽",
    text: "亡语：召唤两只1/1的蜘蛛。",
    effect: "wolf",
  },
  {
    id: "BGS_017",
    name: "族群领袖",
    tier: 3,
    attack: 3,
    health: 3,
    tribe: "无",
    text: "每当你召唤一个野兽，使其获得+3攻击力。",
    effect: "pack",
  },
  {
    id: "EX1_556",
    name: "麦田傀儡",
    tier: 3,
    attack: 2,
    health: 3,
    tribe: "机械",
    text: "亡语：召唤一个2/1的损坏的傀儡。",
    effect: "golem",
  },
  {
    id: "LOOT_078",
    name: "洞穴多头蛇",
    tier: 4,
    attack: 2,
    health: 4,
    tribe: "野兽",
    text: "同时对其攻击目标相邻的随从造成伤害。",
    effect: "cleave",
  },
  {
    id: "EX1_534",
    name: "长鬃草原狮",
    tier: 4,
    attack: 6,
    health: 5,
    tribe: "野兽",
    text: "亡语：召唤两只2/2的土狼。",
    effect: "lion",
  },
  {
    id: "BOT_218",
    name: "安保巡游者",
    tier: 4,
    attack: 2,
    health: 6,
    tribe: "机械",
    text: "每当本随从受到伤害，召唤一个2/3并具有嘲讽的机械。",
    effect: "rover",
  },
  {
    id: "EX1_093",
    name: "阿古斯防御者",
    tier: 4,
    attack: 2,
    health: 3,
    tribe: "无",
    text: "战吼：使相邻的随从获得+1/+1和嘲讽。",
    effect: "argus",
  },
  {
    id: "BOT_911",
    name: "吵吵模组",
    tier: 4,
    attack: 2,
    health: 4,
    tribe: "机械",
    text: "磁力、圣盾、嘲讽。可选择友方机械进行融合。",
    keywords: ["圣盾", "嘲讽"],
    effect: "magnetic",
  },
  {
    id: "LOE_077",
    name: "布莱恩·铜须",
    tier: 5,
    attack: 2,
    health: 4,
    tribe: "无",
    text: "你的战吼会触发两次。",
    effect: "brann",
  },
  {
    id: "FP1_031",
    name: "瑞文戴尔男爵",
    tier: 5,
    attack: 1,
    health: 7,
    tribe: "无",
    text: "你的随从的亡语将触发两次。",
    effect: "baron",
  },
  {
    id: "BGS_009",
    name: "光牙执行者",
    tier: 5,
    attack: 2,
    health: 2,
    tribe: "无",
    text: "在你的回合结束时，使每个类型的各一个友方随从获得+2/+2。",
    effect: "lightfang",
  },
  {
    id: "LOOT_368",
    name: "虚空领主",
    tier: 5,
    attack: 3,
    health: 9,
    tribe: "恶魔",
    text: "嘲讽。亡语：召唤三个1/3并具有嘲讽的恶魔。",
    keywords: ["嘲讽"],
    effect: "voidlord",
  },
  {
    id: "FP1_010",
    name: "迈克斯纳",
    tier: 6,
    attack: 2,
    health: 8,
    tribe: "野兽",
    text: "剧毒。",
    keywords: ["剧毒"],
  },
  {
    id: "GVG_113",
    name: "死神4000型",
    tier: 6,
    attack: 6,
    health: 9,
    tribe: "机械",
    text: "同时对其攻击目标相邻的随从造成伤害。",
    effect: "cleave",
  },
  {
    id: "BGS_021",
    name: "熊妈妈",
    tier: 6,
    attack: 4,
    health: 4,
    tribe: "野兽",
    text: "每当你召唤一个野兽，使其获得+4/+4。",
    effect: "mama",
  },
  {
    id: "BGS_008",
    name: "阴森巨蟒",
    tier: 6,
    attack: 7,
    health: 7,
    tribe: "野兽",
    text: "亡语：随机召唤两个亡语随从。",
    effect: "coiler",
  },
  {
    id: "LOOT_013",
    name: "粗俗的矮劣魔",
    tier: 1,
    attack: 2,
    health: 4,
    tribe: "恶魔",
    text: "嘲讽。战吼：对你的英雄造成2点伤害。",
    keywords: ["嘲讽"],
    effect: "vulgar",
  },
  {
    id: "BGS_001",
    name: "纳斯雷兹姆监工",
    tier: 2,
    attack: 2,
    health: 3,
    tribe: "恶魔",
    text: "战吼：使一个友方恶魔获得+2/+2。",
    effect: "overseer",
  },
];
export const TOKENS: CardDef[] = [
  {
    id: "voidlord-token",
    name: "虚空行者",
    tier: 1,
    attack: 1,
    health: 3,
    tribe: "恶魔",
    text: "嘲讽",
    keywords: ["嘲讽"],
    token: true,
  },
  {
    id: "cat-token",
    name: "雌斑虎",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "野兽",
    text: "由雄斑虎召唤。",
    token: true,
  },
  {
    id: "scout-token",
    name: "鱼人斥候",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "鱼人",
    text: "由鱼人猎潮者召唤。",
    token: true,
  },
  {
    id: "kangaroo-token",
    name: "机械袋鼠宝宝",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "机械",
    text: "由机械袋鼠召唤。",
    token: true,
  },
  {
    id: "grandmother-token",
    name: "大灰狼",
    tier: 1,
    attack: 3,
    health: 2,
    tribe: "野兽",
    text: "由慈祥的外婆召唤。",
    token: true,
  },
  {
    id: "wolf-token",
    name: "蜘蛛",
    tier: 1,
    attack: 1,
    health: 1,
    tribe: "野兽",
    text: "由寄生恶狼召唤。",
    token: true,
  },
  {
    id: "lion-token",
    name: "土狼",
    tier: 1,
    attack: 2,
    health: 2,
    tribe: "野兽",
    text: "由长鬃草原狮召唤。",
    token: true,
  },
  {
    id: "golem-token",
    name: "损坏的傀儡",
    tier: 1,
    attack: 2,
    health: 1,
    tribe: "机械",
    text: "由麦田傀儡召唤。",
    token: true,
  },
  {
    id: "rover-token",
    name: "护卫机器人",
    tier: 1,
    attack: 2,
    health: 3,
    tribe: "机械",
    text: "嘲讽",
    keywords: ["嘲讽"],
    token: true,
  },
];
export const ALL_CARDS = [
  ...CARDS,
  ...TOKENS,
  ...SEASON_CATALOG,
  ...SEASON_SPELL_CATALOG,
  ...SEASON_RELATED,
];
export const getDef = (id: string) => ALL_CARDS.find((c) => c.id === id)!;
export const POOL_COPIES = [0, 15, 15, 13, 11, 9, 7];
export const SHOP_SIZE = [0, 3, 4, 4, 5, 5, 6];
export const UPGRADE_COST = [0, 5, 7, 8, 9, 10, 0];
export interface Hero {
  armor?: number;
  id: string;
  name: string;
  title: string;
  power: string;
  text: string;
  cost: number;
  health: number;
  art: string;
  passive?: boolean;
}
export const CLASSIC_HEROES: Hero[] = [
  {
    id: "lich",
    name: "巫妖王",
    title: "冰封王座的统治者",
    power: "复生仪式",
    text: "使一个友方随从在下一场战斗中获得复生。",
    cost: 1,
    health: 40,
    art: "TB_BaconShop_HERO_22",
  },
  {
    id: "millificent",
    name: "米尔菲丝·法力风暴",
    title: "机械大师",
    power: "机械改装",
    text: "被动：酒馆中的机械获得+1/+1。",
    cost: 0,
    health: 40,
    art: "TB_BaconShop_HERO_17",
    passive: true,
  },
  {
    id: "patchwerk",
    name: "帕奇维克",
    title: "血肉巨人",
    power: "缝合之躯",
    text: "被动：初始生命值为60点。",
    cost: 0,
    health: 60,
    art: "TB_BaconShop_HERO_34",
    passive: true,
  },
  {
    id: "pyramid",
    name: "疯狂金字塔",
    title: "古老的守护者",
    power: "层层防御",
    text: "随机使一个友方随从获得+2生命值。",
    cost: 1,
    health: 40,
    art: "TB_BaconShop_HERO_39",
  },
  {
    id: "george",
    name: "堕落的乔治",
    title: "最后的圣骑士",
    power: "圣光恩泽",
    text: "使一个友方随从获得圣盾。",
    cost: 4,
    health: 40,
    art: "TB_BaconShop_HERO_15",
  },
  {
    id: "jaraxxus",
    name: "加拉克苏斯大王",
    title: "艾瑞达之王",
    power: "血怒",
    text: "使你的恶魔获得+1/+1。",
    cost: 3,
    health: 40,
    art: "TB_BaconShop_HERO_37",
  },
  {
    id: "bartender",
    name: "调酒机器人",
    title: "酒馆好帮手",
    power: "熟客优惠",
    text: "被动：升级酒馆所需的铸币减少1枚。",
    cost: 0,
    health: 40,
    art: "TB_BaconShop_HERO_31",
    passive: true,
  },
  {
    id: "nefarian",
    name: "奈法利安",
    title: "黑翼之主",
    power: "吐息",
    text: "下一场战斗开始时，对所有敌方随从造成1点伤害。",
    cost: 1,
    health: 40,
    art: "TB_BaconShop_HERO_30",
  },
];
export const HEROES: Hero[] = [...CLASSIC_HEROES, ...SEASON_HEROES];
export const art = (id: string) =>
  id.startsWith("s14_")
    ? assetUrl("art/" + id.slice(4) + ".png")
    : assetUrl(
        "art/" +
          (id.endsWith("-token")
            ? {
                "voidlord-token": "CS2_065",
                "cat-token": "CFM_315",
                "scout-token": "EX1_506",
                "kangaroo-token": "BOT_445",
                "grandmother-token": "KAR_005",
                "wolf-token": "OG_216",
                "lion-token": "EX1_534",
                "golem-token": "EX1_556",
                "rover-token": "BOT_218",
              }[id] || "CFM_315"
            : id) +
          ".png",
      );

const GOLDEN_TEXT: Record<string, string> = {
  cat: "战吼：召唤一头2/2的雌斑虎。",
  scout: "战吼：召唤一个2/2的鱼人斥候。",
  tidecaller: "每当你召唤一个鱼人，便获得+2攻击力。",
  kangaroo: "亡语：召唤一个2/2的机械袋鼠宝宝。",
  weaver: "在你使用一张恶魔牌后，对你的英雄造成1点伤害并获得+4/+4。",
  selfless: "亡语：随机使两个友方随从获得圣盾。",
  rockpool: "战吼：使一个友方鱼人获得+2/+2。",
  spawn: "亡语：使你的所有随从获得+2/+2。",
  grandmother: "亡语：召唤一只6/4的大灰狼。",
  metaltooth: "战吼：使你的其他机械获得+4攻击力。",
  pogo: "战吼：在本局对战中，你每使用过一张其他蹦蹦兔，便获得+4/+4。",
  hyena: "每当一个友方野兽死亡，便获得+4/+2。",
  coldlight: "战吼：使你的其他鱼人获得+4生命值。",
  wolf: "亡语：召唤两只2/2的蜘蛛。",
  pack: "每当你召唤一个野兽，使其获得+6攻击力。",
  golem: "亡语：召唤一个4/2的损坏的傀儡。",
  lion: "亡语：召唤两只4/4的土狼。",
  rover: "每当本随从受到伤害，召唤一个4/6并具有嘲讽的机械。",
  argus: "战吼：使相邻的随从获得+2/+2和嘲讽。",
  brann: "你的战吼会触发三次。",
  baron: "你的随从的亡语将触发三次。",
  lightfang: "在你的回合结束时，使每个类型的各一个友方随从获得+4/+4。",
  voidlord: "嘲讽。亡语：召唤三个2/6并具有嘲讽的恶魔。",
  mama: "每当你召唤一个野兽，使其获得+8/+8。",
  coiler: "亡语：随机召唤四个亡语随从。",
  overseer: "战吼：使一个友方恶魔获得+4/+4。",
};
export function cardText(m: { id: string; golden: boolean }) {
  const d = getDef(m.id);
  if (d.season) return m.golden ? d.goldenText || d.text : d.text;
  return (m.golden && d.effect && GOLDEN_TEXT[d.effect]) || d.text;
}
