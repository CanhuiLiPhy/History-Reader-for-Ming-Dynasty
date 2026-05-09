#!/usr/bin/env node
/**
 * Timeline classifier — BUILD-ONLY script.
 *
 * Reads `backend/src/data/明代大事年表-完整版.txt`, classifies every event with
 * the regex-based classifier + manual EVENT_OVERRIDES, and writes the result
 * to the `timeline_events` table in `backend/.cache/library.sqlite`.
 *
 * After running this once, the runtime backend (timeline-service.js) reads
 * directly from the DB and the classifier never runs in production. To tweak
 * a single event's category/scale without re-running the classifier, just
 * UPDATE the row in SQLite — your edit survives subsequent re-runs only if
 * you don't run this script again (which wipes & re-classifies from scratch).
 *
 * Re-run the script when:
 *   - the txt source file has new/edited events
 *   - you change the classifier rules and want a fresh sweep
 *
 * Run: `node backend/scripts/build-timeline.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TIMELINE_PATH = path.join(REPO_ROOT, "backend", "src", "data", "明代大事年表-完整版.txt");
const DB_PATH = path.join(REPO_ROOT, "backend", ".cache", "library.sqlite");

const ALL_CATEGORIES = ["皇室","政争","制度","军事","民变","外交","经济","灾异","文化","人物","其他"];

// Manual classifier overrides — when a description contains a fragment listed
// here, it bypasses the regex pipeline. Use sparingly for events whose
// rule-based classification is wrong (e.g., picks up a 建元 keyword from a
// peasant uprising and misfiles as 皇室).
const EVENT_OVERRIDES = [
  { match: "李新起事", category: "民变", scale: 3 },
];

// Two-stage classifier: pick category by priority-ordered keyword matching,
// then score by category-specific rules. Year context lets us treat 元末 actors
// like 朱元璋 / 陈友谅 / 徐寿辉 differently from emperor朱元璋 (post-1368).
function classifyEvent(text, year = 0) {
  const isYuanEnd = year > 0 && year < 1368;

  // ============ Priority 0: 元末群雄 (pre-1368) ============
  if (isYuanEnd) {
    // 称帝/称王/国号 — 建国级 (scale 5)
    if (/(陈友谅|徐寿辉|张士诚|明玉珍|韩林儿|朱元璋).{0,15}(称帝|称王|为帝|为王|国号|建国)/.test(text) ||
        /(刘福通.{0,5}(迎|为).{0,5}韩林儿)|号大?(汉|周|宋|夏|天完)|(国号大?|建国号).{0,3}(汉|周|宋|夏|天完|吴)/.test(text)) {
      return { category: "皇室", scale: 5 };
    }
    // 元末政权 迁都/改元/建元 — sub-state level (scale 3)
    if (/(陈友谅|徐寿辉|张士诚|明玉珍|韩林儿).{0,15}(迁都|改元|建元)/.test(text)) {
      return { category: "民变", scale: 3 };
    }
    // 朱元璋称吴国公 / 张士诚为太尉等
    if (/(朱元璋|徐达|常遇春|陈友谅|张士诚|徐寿辉|明玉珍|刘福通|方国珍).{0,15}(称吴国公|为吴国公|授太尉|封.{0,5}王)/.test(text)) {
      return { category: "皇室", scale: 4 };
    }
    // 元末群雄取/陷/攻/克 城府
    if (/(朱元璋|徐达|常遇春|陈友谅|张士诚|徐寿辉|明玉珍|刘福通|郭子兴|彭和尚|方国珍|毛贵|关先生).{0,15}(取|克|陷|攻下|攻克|破|围|大破|进围|攻占|占)/.test(text)) {
      return { category: "民变", scale: 3 };
    }
    // 朱元璋遣将/募兵/赴援等
    if (/(朱元璋|徐达|常遇春|陈友谅|张士诚|徐寿辉|刘福通|福通|郭子兴|方国珍|毛贵|关先生).{0,15}(遣|领众|出兵|募兵|赴援|领兵|渡江|附|降|还|自为丞相|为丞相|为太尉)/.test(text)) {
      return { category: "民变", scale: 2 };
    }
    // 元朝镇压义军
    if (/(脱脱|察罕帖木儿|李思齐|扩廓帖木儿|孛罗帖木儿|王保保).{0,15}(破|败|大破|讨|平|杀|授|相攻|为相)/.test(text)) {
      return { category: "军事", scale: 3 };
    }
  }


  // ============ Priority 1: 皇室 (帝王个人/政变/大案) ============
  if (/(朱.|英宗|世宗|宪宗|孝宗|武宗|穆宗|神宗|光宗|熹宗|思宗|福临|玄烨|顺帝).{0,8}(即位|嗣位|登基|即帝位|即汗位|称帝)/.test(text) ||
      /(顺治|玄烨|福临).{0,4}(即位|登基)/.test(text) ||
      /朱元璋称帝|朱棣.{0,4}即位|努尔哈赤.{0,8}即汗位|皇太极.{0,4}(即位|称帝)/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  if (/(朱元璋|朱棣|朱允炆|朱高炽|朱瞻基|朱祁镇|朱祁钰|朱见深|朱祐樘|朱厚照|朱厚熜|朱载垕|朱翊钧|朱常洛|朱由校|朱由检|朱由榔|朱由崧|努尔哈赤|皇太极|福临|顺治).{0,3}卒|(顺帝|英宗|世宗|宪宗|孝宗|武宗|穆宗|神宗|光宗|熹宗|思宗).{0,3}卒/.test(text) ||
      /崇祯帝.{0,3}(自缢|死)|明帝.{0,3}(自缢|亡)|明亡|宋亡|元亡|建文.{0,4}(亡|帝亡)/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  if (/胡惟庸案|胡惟庸狱|蓝玉案|蓝玉狱|郭桓案|郭桓狱|空印案|空印狱|大礼议|靖难|夺门|己巳之变|庚戌之变|壬寅宫变|红丸案|梃击案|移宫案|南北榜/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  if (/迁都|建都北京|定都|建国号|国号大|改元|建元/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  // 太上皇 / 英宗送还 / 复辟
  if (/送还.{0,3}(英宗|帝|太上皇)|英宗.{0,3}(复辟|复位)|(迎|奉).{0,3}(英宗|太上皇).{0,3}(还|归|入)|太上皇/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  if (/(立|册).{0,5}(皇太子|太子|皇后|皇贵妃|贵妃)|废.{0,3}(皇太子|太子|皇后)/.test(text)) {
    return { category: "皇室", scale: 4 };
  }
  if (/三杨|辅政|监国|大封功臣|大封诸王|分封诸王/.test(text)) {
    return { category: "皇室", scale: 4 };
  }

  // ============ Priority 2: 民变 (农民起义/帝/王级) ============
  if (/(李自成|张献忠|高迎祥|徐寿辉|刘福通|韩林儿|郭子兴|王嘉胤).{0,15}(称帝|为帝|建国|为王|号大|国号|攻入|攻陷.{0,3}府|入北京|入西安|破西安|建元|大顺|大西)/.test(text) ||
      /闯王.{0,3}(立|为|号)|号大顺|号大西|建大顺|建大西/.test(text)) {
    return { category: "民变", scale: 5 };
  }
  if (/(李自成|张献忠|高迎祥|王嘉胤|刘福通|徐寿辉).{0,15}(起义|起兵|起事|攻克|破|陷|杀.{0,3}王)/.test(text)) {
    return { category: "民变", scale: 4 };
  }
  if (/(白莲教|红巾军|闯王|大顺|大西|义军).{0,10}(起|攻|破|号|入|败)/.test(text)) {
    return { category: "民变", scale: 3 };
  }
  if (/起义|起兵|起事|聚众.{0,3}起|民变|蛮变|苗变|瑶变|僮变|海寇|海盗.{0,5}起/.test(text)) {
    return { category: "民变", scale: 2 };
  }

  // ============ Priority 2.5: 明清易代关键事件 ============
  if (/(史可法|马士英).{0,10}(拥|建|立).{0,5}(福王|唐王|鲁王|桂王|永明|南京|弘光|隆武|永历)/.test(text) ||
      /拥.{0,5}(福王|唐王|鲁王|桂王|永明).{0,5}(即位|建|立|称帝|监国)/.test(text) ||
      /薙发.{0,3}令|薙发|剃发令|发饬|圈地令.{0,5}颁|大顺.{0,3}军.{0,3}(入城|入京)/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  if (/(进|入|攻).{0,3}(成都|北京|西安|南京|重庆|武昌).{0,3}(建|为).{0,3}(国|都)|传檄|建政权|建.{0,3}(弘光|隆武|永历|大顺|大西).{0,3}朝/.test(text) ||
      /多尔衮.{0,5}(摄政|入北京|入京|定都)|清军.{0,5}入关|清兵.{0,5}入关|顺治.{0,5}定都|清下.{0,5}令/.test(text)) {
    return { category: "军事", scale: 4 };
  }

  // ============ Priority 3: 顶级军事 ============
  // scale 5 — 改朝换代级 / 决定王朝命运
  if (/土木堡|萨尔浒|松山.{0,4}(战|陷|降)|宁远.{0,3}(大捷|大战)|鄱阳湖.{0,3}战|北京保卫|城陷.{0,3}(亡|入)/.test(text)) {
    return { category: "军事", scale: 5 };
  }
  if (/吴三桂.{0,5}(引清兵|入关|降清|攻明)|清兵.{0,5}入关|清军.{0,5}入关/.test(text)) {
    return { category: "军事", scale: 5 };
  }
  // scale 4 — 重大边境战役 / 名将出征
  if (/捕鱼儿海|忽兰忽失温/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  if (/施琅.{0,5}(攻|破|克|平).{0,3}(台湾|金门|厦门|郑)|郑成功.{0,5}(攻|围|克).{0,3}(南京|江宁|台湾|金门|厦门)/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 明军主动斩杀外族首领 → 军事 scale 4 (例如：明军杀也先)
  if (/明.{0,3}(军|将|兵).{0,10}(杀|斩|擒).{0,3}(也先|脱欢|本雅失里|阿鲁台|马哈木|脱古思帖木儿|可汗|首领|领袖|大酋长)/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 外族内乱 (杀首领/拥立) → 军事 scale 3
  if (/(也先|脱欢|本雅失里|阿鲁台|马哈木|脱古思帖木儿|鬼力赤|坤帖木儿).{0,5}(被杀|为.{0,3}所杀)/.test(text) ||
      /(阿剌|阿鲁台|脱欢|马哈木|皇太极|努尔哈赤|多尔衮).{0,3}(杀|立).{0,3}(也先|脱欢|本雅失里|阿鲁台|马哈木|脱古思帖木儿|麻儿可儿|鬼力赤|可汗)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 拥立可汗 (单纯立)
  if (/立.{0,5}(可汗|为.{0,3}可汗|为.{0,3}汗)/.test(text)) {
    return { category: "军事", scale: 3 };
  }

  // ============ Priority 4: 灾异 ============
  // scale 4 — 仅全国/多省级 (河决全国大水/黄河决口/灾遍全国/连年连岁)
  if (/(全国大水|灾遍全国|遍.{0,3}国)/.test(text)) {
    return { category: "灾异", scale: 4 };
  }
  if (/(河决|黄河决|江河大决).{0,15}(数千里|千里|数百里|改道|大决|多省|数省)/.test(text)) {
    return { category: "灾异", scale: 4 };
  }
  // 连岁/连年大饥 默认为 3 (区域性), 仅当明确"全国/数省"时升 4
  if (/(连岁大饥|连年大饥).{0,15}(全国|数省|多省|遍.{0,3}国)/.test(text)) {
    return { category: "灾异", scale: 4 };
  }
  // scale 3 — 区域级大灾 (含人相食/溺死过千/大饥/大水/大旱/大疫/海溢/颱风)
  if (/(人相食|父子相食|赤地千里|尸横遍野|易子而食)/.test(text)) {
    return { category: "灾异", scale: 3 };
  }
  if (/(死|溺死|饿死).{0,5}([万千][余之]?人|百万|十万|数十万)/.test(text)) {
    return { category: "灾异", scale: 3 };
  }
  if (/京师大饥|颱风海潮|颱风/.test(text)) {
    return { category: "灾异", scale: 3 };
  }

  // ============ Priority 4.5: 大狱/杀大臣/党争 ============
  // 5 — 杀开国功臣/顶级权臣 (只留真核心：李善长/蓝玉/胡惟庸/方孝孺/傅友德/冯胜/常遇春)
  if (/杀.{0,3}(李善长|蓝玉|胡惟庸|徐达|常遇春|傅友德|冯胜|方孝孺)/.test(text)) {
    return { category: "政争", scale: 5 };
  }
  // 4 — 杀其他高级官员 (齐泰/黄子澄/于谦/严嵩家/魏忠贤等)
  if (/杀.{0,3}(齐泰|黄子澄|于谦|严世蕃|杨涟|左光斗|杨继盛|张经|熊廷弼|袁崇焕|周延儒)/.test(text)) {
    return { category: "政争", scale: 4 };
  }
  // 4 — 株连百余/数千人 / 大狱具
  if (/百余人|株连.{0,3}(甚众|数百|千余|余人|甚.{0,3}数千)|大狱|.{1,5}之狱(起|具)|伏诛.{0,3}籍其家/.test(text)) {
    return { category: "政争", scale: 4 };
  }
  // 4 — 东林党争
  if (/东林.{0,5}(党争|党祸|党狱)|谕示东林党人狱/.test(text)) {
    return { category: "政争", scale: 4 };
  }
  // 3 — 权臣杀部下 (严嵩/魏忠贤/王振/刘瑾)
  if (/(严嵩|魏忠贤|王振|刘瑾|杨嗣昌).{0,8}(杀|诛|害|劾|陷|阴害).{0,5}(御史|左光斗|杨涟|李|于|马|刘|王|张|周|顾|陈|何|徐|王锡爵)/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 3 — X劾Y / Y被诬下狱 / 御史劾X
  if (/(劾|弹劾|论).{0,8}(严嵩|严世蕃|魏忠贤|王振|刘瑾|徐阶|温体仁|周延儒|马士英|阮大铖)|因劾.{0,5}(严嵩|严世蕃|魏忠贤|王振|刘瑾)|被诬下狱|被诬死|杨继盛|齐康|御史.{0,5}劾/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 3 — 建生祠 / 立生祠 (权臣 vanity)
  if (/建.{0,3}生祠|立.{0,3}生祠|建.{0,3}祠堂.{0,3}于/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 3 — 唐王/福王/鲁王/桂王 内部冲突 (诛使节/杀X)
  if (/(唐王|鲁王|福王|桂王|永明王|永历).{0,5}(诛|杀).{0,3}(使节|大臣|王|官)/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 3 — 名将诱杀对方首脑
  if (/(胡宗宪|戚继光|俞大猷).{0,5}(诱杀|斩|擒).{0,5}(汪直|徐海|林凤|海寇)/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 3 — 大计全国官吏
  if (/大计.{0,3}(全国|京官|官吏|外官)/.test(text)) {
    return { category: "政争", scale: 3 };
  }

  // ============ Priority 4.6: 重要皇室/迁都/即位 ============
  // 5 — 燕王即位 / 都北京 / 太子即位 (注: 单字"燕王"也算)
  if (/燕王.{0,5}(于南京.{0,3}即位|即位)|太子.{0,3}(见深|高炽|瞻基|祁镇|祁钰|常洛|由校|由检|允炆|高煦|宸濠).{0,3}即位|^都北京/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  // 4 — 始建北京城 / 始建北京宫殿 / 成祖到北京 / 定都北京
  if (/始建北京(城|宫殿)|成祖.{0,5}到北京|定都北京/.test(text)) {
    return { category: "皇室", scale: 4 };
  }
  // 3 — 兴建长陵 / 重要工程
  if (/兴建.{0,3}(长陵|景陵|献陵|裕陵|茂陵|泰陵|康陵|永陵|定陵|庆陵|昭陵|思陵)|始建.{0,3}(陵|宫|殿)/.test(text)) {
    return { category: "皇室", scale: 3 };
  }
  // 3 — 燕王/晋王/秦王等就藩
  if (/(燕王|秦王|晋王|周王|楚王|蜀王|齐王|汉王|宁王|福王).{0,8}就藩/.test(text)) {
    return { category: "皇室", scale: 3 };
  }
  // 2 — 帝行程 (回南京/巡边/北游/南游)
  if (/(成祖|帝|宣宗|英宗|世宗|武宗|神宗).{0,5}(回南京|巡边|北游|南游|至洗马林)/.test(text)) {
    return { category: "皇室", scale: 2 };
  }

  // ============ Priority 4.7: 史可法/南明大事 ============
  // 5 — 史可法殉国 / 文天祥级殉国
  if (/(史可法|文天祥|忠烈|刘宗周|黄道周).{0,5}(殉国|殉难|殉节|战死)/.test(text)) {
    return { category: "皇室", scale: 5 };
  }
  // 4 — 郑成功/李定国/张煌言抗清
  if (/(郑成功|李定国|张煌言).{0,5}(入海岛|起兵抗清|据.{0,3}(厦门|金门|台湾|沿海)|围.{0,3}(南京|江宁|广州))/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 3 — 桂王/福王/唐王/鲁王 逃 X
  if (/(桂王|福王|唐王|鲁王|永明王|永历).{0,5}(逃|奔|走|入|至|往).{0,5}(桂林|肇庆|安隆|缅甸|永昌|腾越|南宁|梧州|福州|厦门|台湾)/.test(text)) {
    return { category: "皇室", scale: 3 };
  }

  // ============ Priority 4.8: 农民起义 大事 ============
  // 4 — 一时并起 / 称帝建国 / 决黄河
  if (/一时并起|据.{0,3}(襄阳|开封|西安|武昌|凤阳).{0,5}(建|称).{0,3}(王|元帅|国|帝)|建.{0,5}(大顺|大西).{0,3}(国|王)/.test(text)) {
    return { category: "民变", scale: 4 };
  }
  if (/(决|引).{0,3}(黄河|大江|河).{0,3}(灌|淹|沉).{0,3}(开封|城|府)/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 4 — 张献忠/李自成 进驻/入X (建立基地)
  if (/(张献忠|李自成).{0,5}(进驻|入|破|攻克).{0,3}(成都|武昌|襄阳|开封|西安|洛阳|凤阳)/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 3 — 拥X为闯王 / 起义军占领府城
  if (/拥.{0,5}(高迎祥|李自成|张献忠).{0,3}(为|号).{0,3}(闯|王|帅)/.test(text)) {
    return { category: "民变", scale: 3 };
  }
  if (/(高迎祥|王嘉胤|王自用|张献忠|李自成).{0,5}(取|克|破|攻克|入|出).{0,3}(府|州|城|延安|庆阳|府谷|河南|陕西|湖广|安徽|延绥|米脂)/.test(text)) {
    return { category: "民变", scale: 3 };
  }
  // 3 — 张献忠受抚
  if (/(张献忠|李自成|高迎祥|王自用).{0,5}(受抚|降.{0,3}(明|顺))/.test(text)) {
    return { category: "民变", scale: 3 };
  }

  // ============ Priority 4.9: 努尔哈赤崛起 ============
  // 4 — 努尔哈赤征服 / 灭部
  if (/努尔哈赤.{0,5}(征服|灭).{0,5}(部|诸部|海西|建州|长白|哈达|辉发|乌拉|叶赫)/.test(text)) {
    return { category: "军事", scale: 4 };
  }

  // ============ Priority 4.95: 大将统帅任命 / 抗敌大事 ============
  // 4 — 命洪承畴督辽事 / 命XX督辽东 等顶级军事任命
  if (/(命|以).{0,5}(洪承畴|袁崇焕|熊廷弼|孙承宗|杨嗣昌|卢象升|孙传庭|戚继光|俞大猷|李成梁|李如松|宋应昌|王骥|蓝玉|徐达|常遇春|沐英|汤和|傅友德|冯胜).{0,5}督.{0,3}(辽|蓟|宣大|三边|川|滇|湖广|两广)/.test(text)) {
    return { category: "军事", scale: 4 };
  }
  // 3 — 命XX征/统帅出征 (战略级地区)
  if (/(命|遣).{0,5}(蓝玉|徐达|常遇春|汤和|傅友德|沐英|王骥|戚继光|俞大猷|李成梁|洪承畴|宋礼|刘大夏).{0,5}(征|讨|攻|出|帅|总制|总督)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 3 — X克/平/降 战略级地区 (云南/大理/交趾/安南/宁夏/哈密/西番/西域/辽东)
  if (/.{0,5}(克|平|破|降|定).{0,3}(云南|大理|交趾|大宁|安南|宁夏|哈密|罕东|赤斤|沙州|金山|岭南|西域|西番)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 3 — 名将抗倭/逐倭/平倭
  if (/(戚继光|俞大猷|胡宗宪|张经|谭纶|王仪|王忤).{0,5}(逐|平|败|大破|破).{0,3}(倭|寇)|.{0,3}逐倭出.{0,3}(浙江|福建|广东)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 3 — 名将筑城/筑堡 (边防大事)
  if (/(袁崇焕|戚继光|余子俊|刘大夏|马芳).{0,5}筑.{0,3}(城|堡|关|宁远|镇|边墙|长城)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 3 — X弃堡 / 弃X (战略撤退)
  if (/弃.{0,3}(辽东|六堡|河套|开平|大宁|宁远).{0,3}/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 3 — 名将败X (击败义军/敌方)
  if (/(卢象升|洪承畴|曹文诏|孙传庭|杨嗣昌|周遇吉).{0,5}(败|大破|破|击破).{0,3}(李自成|张献忠|高迎祥|王嘉胤|王自用|罗汝才|刘宗敏)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 2 — 一般大将克城 (汤和克成都之类)
  if (/(汤和|徐达|常遇春|蓝玉|傅友德|沐英|周遇吉|秦良玉|戚继光|俞大猷).{0,5}(克|破|降).{0,5}(城|府|州|县|成都|重庆|衡州|长沙|武昌|汉阳|应天|平江|淮安|徐州|延平|庆元|镇江)/.test(text)) {
    return { category: "军事", scale: 2 };
  }
  // 2 — 诱执 / 招抚 / 计擒 等手段制敌
  if (/(诱执|计擒|招抚|招降|擒).{0,5}(宁王|宸濠|王|首领|可汗)/.test(text)) {
    return { category: "军事", scale: 2 };
  }

  // ============ Priority 4.97: 立武举/立连坐/重要单项制度 ============
  if (/立武举法|始制.{0,3}(佛郎机|红夷|大炮|火炮)|始造.{0,3}(火器|炮)/.test(text)) {
    return { category: "制度", scale: 3 };
  }
  // 3 — 从祀孔庙 (重要文化决定)
  if (/(从祀|配享).{0,3}孔庙|(以|命).{0,5}从祀.{0,3}孔庙/.test(text)) {
    return { category: "制度", scale: 3 };
  }
  // 3 — 西法入华 / 汤若望/利玛窦 进献天文器物
  if (/(汤若望|利玛窦|南怀仁|徐光启).{0,5}(造呈|进|献|奉).{0,3}(历书|天文|地平仪|奇器|火器|炮)|西法.{0,3}入(中国|华)|参用西洋历法/.test(text)) {
    return { category: "文化", scale: 3 };
  }
  // 3 — 元史/明史 单独 (即使没"成")
  if (/^元史$|^明史$|^宋元通鉴$|.{0,3}元史成|.{0,3}明史成/.test(text)) {
    return { category: "文化", scale: 3 };
  }

  // ============ Priority 4.98: 安南/外族重大事件 ============
  // 3 — 黎利反明 / 安南叛 / 安南建国
  if (/黎利.{0,5}(反明|起兵反|叛|为帝|大败明军)|安南.{0,5}(反|叛|建国|遣使.{0,3}请封)/.test(text)) {
    return { category: "外交", scale: 3 };
  }
  // 3 — 天主教传入 / 西法传入 / 西洋历局
  if (/天主教.{0,5}(创立|始传|入华|创立教区)|耶稣会|始置.{0,3}西洋历局|西法.{0,3}入中国/.test(text)) {
    return { category: "外交", scale: 3 };
  }
  // 3 — 中外议和
  if (/(明|大明).{0,5}(日|倭|日本).{0,3}议和.{0,3}(成|约)|册封.{0,3}日本|赐国号/.test(text)) {
    return { category: "外交", scale: 3 };
  }

  // ============ Priority 5: 大权臣 / 政争 ============
  if (/(张居正|严嵩|魏忠贤|王振|刘瑾|胡惟庸|杨廷和|徐阶|高拱|杨嗣昌|温体仁|周延儒|杨涟|顾宪成|海瑞|于谦).{0,8}(入阁|为首辅|首辅|为相|被诛|伏诛|被杀|罢|卒|死|擅权|乱政)/.test(text)) {
    return { category: "政争", scale: 4 };
  }
  if (/(袁崇焕|熊廷弼|孙承宗|洪承畴|卢象升|戚继光|俞大猷|李成梁|毛文龙|张经|杨继盛).{0,5}(被杀|被诛|被劾|被擒|被俘|被罢|降清|战死|阵亡|自杀)/.test(text)) {
    return { category: "政争", scale: 4 };
  }
  if (/(冯保|高淮|马堂|陈奉|魏忠贤).{0,5}(擅权|乱政|起|害)/.test(text)) {
    return { category: "政争", scale: 4 };
  }

  // ============ Priority 6: 制度大变革 ============
  // scale 5 — 改朝换代级制度变革 (只保留最顶级)
  if (/废丞相|罢中书省|改大都督府.{0,3}五军都督府|废宰相|始置内阁|始设巡抚|创锦衣卫|始置锦衣卫|开西厂|开东厂|始置西厂|始置东厂|颁大明律|始造大明宝钞|定卫所制|置殿阁大学士|始行一条鞭|通行一条鞭/.test(text)) {
    return { category: "制度", scale: 5 };
  }
  // scale 4 — 一次性大变革 (科举开/复)
  if (/复科举|罢科举|定科举|初行殿试|初开乡试|始征金花银|大封功臣/.test(text)) {
    return { category: "制度", scale: 4 };
  }
  // scale 3 — 重要法典 / 始立/始设/始置/始命 + 重要 entity
  if (/颁大诰|颁皇明祖训|颁大明会典|颁大明一统志|开会试|立连坐法|严海禁/.test(text)) {
    return { category: "制度", scale: 3 };
  }
  if (/始(立|设|置|建|命|定).{0,5}(直省|省|司|府|卫|监|场|厂|学|提举|官|寺|科|律|典|制)/.test(text)) {
    return { category: "制度", scale: 3 };
  }

  // ============ Priority 7: 文化 / 书成 ============
  // scale 5 — 改朝换代级法典 (实际只有大明律)
  // scale 4 — 顶级著作 (永乐大典/大明律例成等)
  if (/永乐大典.{0,3}成|天工开物.{0,3}成|本草纲目.{0,3}成|徐霞客游记|金瓶梅.{0,3}(刊|本)|西游记.{0,3}(刊|本)|三国演义.{0,3}(刊|本)|水浒传.{0,3}(刊|本)|景教.{0,3}碑/.test(text)) {
    return { category: "文化", scale: 4 };
  }
  // 大明律成 / 大明律例成 / 大明会典成 → 制度 scale 4 (基础大法典)
  if (/(大明律|大明律例|大明会典).{0,3}成/.test(text)) {
    return { category: "制度", scale: 4 };
  }
  // scale 3 — 重要著作 / 实录成 / 通鉴成
  if (/(几何原本|崇祯历书|明史|宋元通鉴|圜容较义|拍案惊奇|警世通言|喻世明言|醒世恒言|帝鉴图说|资治通鉴纲目|寰宇通志|大明一统志|圣政记|宝训|历代名臣奏议|皇明祖训|玉牒|实录).{0,3}(成|纂毕|刊行)|译.{0,5}成/.test(text)) {
    return { category: "文化", scale: 3 };
  }
  // scale 3 — 重修XX实录 (大型多年工程)
  if (/重修.{0,5}(太祖实录|实录|大典|会典|一统志)/.test(text)) {
    return { category: "文化", scale: 3 };
  }
  // scale 2 — 修XX书的诏命 (尚未成书)
  if (/(命|诏|遣).{0,8}修.{0,5}(实录|通鉴|典|图|历|书|志)|诏修|始修.{0,5}(书|典|实录)|^修.{0,5}(实录|典|志)/.test(text)) {
    return { category: "文化", scale: 2 };
  }

  // ============ Priority 8: 名家人物 ============
  // scale 4 — 顶级政治/军事核心 (开国功臣/权臣/总督级名将)
  if (/(刘基|刘伯温|宋濂|徐达|常遇春|李善长|汤和|蓝玉|于谦|张居正|严嵩|王守仁|王阳明|戚继光|俞大猷|海瑞|袁崇焕|熊廷弼|孙承宗|洪承畴|卢象升|史可法|李定国|郑成功|郑和|魏忠贤|王振|刘瑾|胡惟庸|杨廷和|徐阶|高拱|杨嗣昌|何腾蛟|李成梁).{0,3}(卒|死|薨|被诛|被杀|伏诛)/.test(text)) {
    return { category: "人物", scale: 4 };
  }
  // scale 3 — 重要思想家 / 大科学家 / 文化大家
  if (/(李贽|顾炎武|黄宗羲|王夫之|徐光启|利玛窦|李时珍|徐霞客|宋应星|顾宪成|吴承恩|罗贯中|施耐庵|汤显祖|杨嗣昌|宗喀巴).{0,3}(卒|死|薨)/.test(text)) {
    return { category: "人物", scale: 3 };
  }
  // scale 2 — 二线文人 / 画家 / 学者
  if (/(沈周|唐寅|文征明|仇英|薛瑄|陈献章|王廷相|罗钦顺|王世贞|钱谦益|袁宏道|董其昌|凌濛初|冯梦龙|陈洪绶|徐渭|归有光|苏天爵|唐顺之|魏校|王艮|焦竑|丘濬|彭韶|于慎行|叶向高|郑芝龙|柯九思|倪瓒|王蒙|黄公望|吴镇|沈一贯|颜继祖).{0,3}(卒|死|薨)/.test(text)) {
    return { category: "人物", scale: 2 };
  }

  // ============ Priority 9: 外交 ============
  // 郑和第一次 / 第七次 → 4 (开端 + 终点)
  if (/郑和第一次出使南洋|郑和第七次使南洋|郑和第七次出使南洋/.test(text)) {
    return { category: "外交", scale: 4 };
  }
  // 郑成功复台 / 驱荷兰 → 4
  if (/郑成功.{0,5}(进驻台湾|攻台湾|收复台湾|驱.{0,3}荷兰)/.test(text)) {
    return { category: "外交", scale: 4 };
  }
  // 郑和 第二至第六次 → 3
  if (/郑和.{0,5}(下西洋|出使.{0,3}(西洋|南洋)|自(西洋|南洋)还|使(西洋|南洋)|奉使(西洋|南洋)|复使(西洋|南洋))|命郑和.{0,5}(下西洋|使西洋|使南洋)/.test(text)) {
    return { category: "外交", scale: 3 };
  }
  // 西方传教士入华
  if (/利玛窦.{0,5}(至|来|进京|始传)|传教士.{0,5}(至|来|入京)/.test(text)) {
    return { category: "外交", scale: 4 };
  }
  if (/(葡萄牙|荷兰|西班牙|英国|意大利|英国).{0,10}(来明|来华|侵入|寇|攻|窃据|占|商船|船至)/.test(text)) {
    return { category: "外交", scale: 3 };
  }

  // ============ Priority 10: 顶级经济 ============
  // scale 4 — 一次性大经济变革 (废宝钞/废开中盐法/始征金花银/三大饷)
  if (/(加|增).{0,3}(辽饷|剿饷|练饷)|废.{0,3}(开中.{0,3}盐法|宝钞|轮班匠役)|始造.{0,3}(大明.{0,3}宝钞|宝钞)|始征金花银/.test(text)) {
    return { category: "经济", scale: 4 };
  }
  // scale 3 — 加全国田赋 / 加天下田赋 (经常性增赋)
  if (/(加|增|再加|普加).{0,3}(全国|天下).{0,3}(田赋|赋)|岁入.{0,5}增/.test(text)) {
    return { category: "经济", scale: 3 };
  }

  // ============ 中等级别 ============
  // 中等政争 — 高级大臣任免
  if (/入阁|首辅|经略|总督|为相|为太师|参政|被劾|被贬|致仕|起用|罢相|罢.{0,3}(尚书|侍郎|大臣)|削.{0,3}爵/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 以X为Y(高官): 总督/经略/兵部尚书/丞相/巡抚/总兵 — 任命大员
  if (/以.{1,8}为.{0,3}(右?丞相|左?丞相|首辅|总督|总制|经略|尚书|侍郎|巡抚|提督|总兵|大学士|节度|司礼监)/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 命/遣 X 为 Y 大员
  if (/(命|遣|诏命).{0,8}(为|总督|经略|镇守|节制|总制).{0,5}(三边|宣大|蓟辽|川广|湖广|两广|云贵|河防|盐政|总兵|总督|经略)/.test(text)) {
    return { category: "政争", scale: 3 };
  }
  // 普通官员任免 / 进士
  if (/以.{1,6}为.{0,5}(知府|知县|按察|布政|参议|尚书|侍郎|郎中|御史|学士|总管|府尹|大夫|寺卿|监正|翰林)|进士及第|及第|赐.{0,3}进士/.test(text)) {
    return { category: "政争", scale: 2 };
  }
  // scale 2 — 巡按 / 巡边 / 通祀 / 督修等普通制度行为
  if (/(遣|命).{0,5}(御史|监察御史|巡抚|巡按|学士|国子监).{0,5}(巡按|巡边|察|督|分巡|考察)/.test(text)) {
    return { category: "制度", scale: 2 };
  }
  if (/通祀.{0,3}(孔子|岳渎)|赐.{0,3}百官公田|赐.{0,3}勋臣田|大封.{0,3}(功臣|诸王|勋臣)/.test(text)) {
    return { category: "制度", scale: 2 };
  }
  // 中等制度 — 颁/定/设
  if (/(颁|定).{0,5}(律|典|法|制|条例|条章)|设.{0,5}(司|府|卫|监|场|厂|学|提举|官|寺)|(置|建).{0,5}(府|州|县|司|卫|学)|改.{0,5}为|罢.{0,5}(司|府|监|场|厂)/.test(text)) {
    return { category: "制度", scale: 3 };
  }
  // 中等军事 — 京师戒严/亲征/大捷
  if (/京师戒严|京师大震|京师戎严|亲征|出塞|大败|大捷|大举|攻克|破.{0,3}(府|州|城)|战.{0,3}(败|大破|大胜)/.test(text)) {
    return { category: "军事", scale: 3 };
  }
  // 中等灾异 — 区域大灾 (大水/大旱/大饥等) → 3 (用户调整：scale 4 仅留全国级)
  if (/(大水|大旱|大蝗|大饥|大疫|大灾)|河决.{0,5}(里|余里|十里|百里)|海溢|河溢|多省|多府|连年|连岁|遍.{0,3}(国|省)/.test(text)) {
    return { category: "灾异", scale: 3 };
  }
  // 中等外交
  if (/(封|册).{0,5}为.{0,3}(王|国王|顺义王|忠顺王|顺宁王|和宁王|安南王|大宝法王)|互市|开.{0,3}(关|马市|海)|遣使.{0,3}西域|遣使.{0,3}日本|安南|朝鲜.{0,3}(请封|遣使)/.test(text)) {
    return { category: "外交", scale: 3 };
  }
  // 中等经济
  if (/丈量|废.{0,3}(法|制)|改.{0,3}(法|制)|加.{0,3}(田|税|赋|饷|赋税)|赈.{0,5}(数十万|百万|十万)|岁入|岁出|户.{0,3}(部计|部奏)|徙.{0,3}(民|户).{0,5}(屯|实|耕)/.test(text)) {
    return { category: "经济", scale: 3 };
  }
  // 中等文化
  if (/(立|建).{0,5}(学|社学|院|书院)|颁.{0,5}(经|书)|译.{0,5}成|著.{0,5}成|刊行|进.{0,5}(书|图|历)/.test(text)) {
    return { category: "文化", scale: 3 };
  }

  // ============ 普通级别 (scale 2) ============
  // 普通军事 — 常规边事/小战
  if (/犯|寇|攻|侵|败.{0,3}于|战|围|出兵|兵变|哗变|戎严|陷|破|擒|俘|杀.{0,3}使|斩|备倭|捕倭|镇压|招降|招抚|募兵|收兵|赴援|渡江/.test(text)) {
    return { category: "军事", scale: 2 };
  }
  // 投/降 — 投降归附
  if (/(归|降|投).{0,5}(明|清|金|元|后金|郑成功|李自成|张献忠)|降.{0,3}清|降.{0,3}明|降.{0,3}金|来奔|来投|内附/.test(text)) {
    return { category: "军事", scale: 2 };
  }
  // 普通外交
  if (/入贡|朝贡|来朝|来明|来华|遣使|进马|进贡|贡马|贡象|贡狮|献马|献俘/.test(text)) {
    return { category: "外交", scale: 2 };
  }
  // 普通灾异
  if (/水|旱|蝗|疫|河决|饥|海溢|地震|风灾|霹雳|涝/.test(text)) {
    return { category: "灾异", scale: 3 };
  }
  // 普通经济
  if (/赋|税|租|赈|盐|茶|铸|钞|粮|课|徙.{0,3}民|流民|垦荒|开屯田|屯田|徙.{0,3}户|劝农/.test(text)) {
    return { category: "经济", scale: 2 };
  }
  // 普通制度 — 罢/置/复/裁
  if (/置|设|改|定|罢|颁|增|裁|复|废|严申|敕/.test(text)) {
    return { category: "制度", scale: 2 };
  }
  // 一般人物卒
  if (/卒|死|生于|进士/.test(text)) {
    return { category: "人物", scale: 2 };
  }

  // ============ 默认按关键词分类 (scale 1，琐碎细节) ============
  // 元末群雄相关 (即使没具体动作)
  if (isYuanEnd && /(朱元璋|陈友谅|张士诚|徐寿辉|刘福通|方国珍|郭子兴|韩林儿|韩山童|徐达|常遇春|明玉珍|脱脱|察罕|扩廓|孛罗|李思齐|王保保|郭天叙|哈麻|关先生)/.test(text)) {
    return { category: "民变", scale: 2 };
  }
  // 经济细节
  if (/(民|户|口|耕|垦|徙|赋|税|银|金|钱|匠|役|盐|茶|租|粮|课|赈|宽|蠲|纳|商|市|流民|招抚.{0,3}流民)/.test(text)) {
    return { category: "经济", scale: 1 };
  }
  // 军事细节
  if (/(兵|师|军|卫|总兵|敕.{0,3}诸|镇|备|讨|防)/.test(text)) {
    return { category: "军事", scale: 1 };
  }
  // 外交细节: 仅当文本含"贡/使/封/通商/互市"等外交语境，否则归到军事
  if (/(入贡|朝贡|来朝|来明|来华|遣使|进马|进贡|贡马|贡象|贡狮|献马|献俘|互市|通商|封.{0,3}王|册.{0,3}王|和约|乞款|岁币)/.test(text)) {
    return { category: "外交", scale: 1 };
  }
  // 单纯外族名称(无入贡/通商) → 军事 (默认认为是边事/侵扰)
  if (/(鞑靼|瓦剌|朵颜|哈密|吐鲁番|蒙古|建州|后金|满洲|清军|清兵|阿剌|阿鲁台|也先|俺答|脱欢|脱古思|脱脱不花|本雅失里|马哈木|可汗)/.test(text)) {
    return { category: "军事", scale: 2 };
  }
  // 国家名(无外交语境) — 多半是军事冲突/制度
  if (/(朝鲜|安南|暹罗|占城|日本|琉球|乌斯藏|西番|大宝)/.test(text)) {
    return { category: "外交", scale: 2 };
  }
  // 皇室细节(妃嫔/宫廷/番僧/方士等)
  if (/(帝|皇|宫|妃|后|内|宦|番僧|西天僧|方士|道士|斋醮|建醮|建坛|献.{0,3}佛)/.test(text)) {
    return { category: "皇室", scale: 2 };
  }
  // 制度细节
  if (/(置|设|改|定|罢|颁|增|裁|复|废|严申|敕|令)/.test(text)) {
    return { category: "制度", scale: 1 };
  }

  // ============ 兜底 ============
  return { category: "其他", scale: 1 };
}

// =====================================================================
// Build phase: parse, classify, write to DB
// =====================================================================

function parseAllEvents() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    throw new Error(`timeline source not found: ${TIMELINE_PATH}`);
  }
  const raw = fs.readFileSync(TIMELINE_PATH, "utf8");
  const events = [];
  let lastReign = "";
  let lastYear = 0;
  let lineNo = 0;

  for (const rawLine of raw.split("\n")) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;

    const reignHeader = line.match(/^(?:公元(\d+)~(\d+)([一-龥]+))$|^([一-龥]+)公年(\d+)~(\d+)$/);
    if (reignHeader) {
      lastReign = reignHeader[3] || reignHeader[4] || lastReign;
      continue;
    }

    const m = line.match(/^公元(\d{3,4})年[（,，]([一-龥]+?)([元\d一二三四五六七八九十]+)年[）,，](.+)$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const reign = m[2];
      const reignYearText = m[3];
      const description = m[4].trim();
      let { category, scale } = classifyEvent(description, year);
      const ov = EVENT_OVERRIDES.find((o) => description.includes(o.match));
      if (ov) { category = ov.category; scale = ov.scale; }
      events.push({ year, reign, reignYearText, description, category, scale, sourceLine: lineNo });
      lastReign = reign;
      lastYear = year;
      continue;
    }

    if (lastYear) {
      let { category, scale } = classifyEvent(line, lastYear);
      const ov = EVENT_OVERRIDES.find((o) => line.includes(o.match));
      if (ov) { category = ov.category; scale = ov.scale; }
      events.push({ year: lastYear, reign: lastReign, reignYearText: "", description: line, category, scale, sourceLine: lineNo });
    }
  }

  events.sort((a, b) => (a.year - b.year) || (a.sourceLine - b.sourceLine));
  return events;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      reign TEXT,
      reign_year_text TEXT,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      scale INTEGER NOT NULL CHECK (scale BETWEEN 1 AND 5),
      source_line INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_year ON timeline_events(year);
    CREATE INDEX IF NOT EXISTS idx_timeline_category ON timeline_events(category);
    CREATE INDEX IF NOT EXISTS idx_timeline_scale ON timeline_events(scale);
  `);
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`library DB not found: ${DB_PATH}`);
  }
  console.log(`reading: ${TIMELINE_PATH}`);
  const events = parseAllEvents();
  console.log(`parsed ${events.length} events`);

  // distribution preview so the user can spot-check before commit
  const byScale = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byCategory = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0]));
  for (const e of events) {
    byScale[e.scale]++;
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  }
  console.log("scale distribution:", byScale);
  console.log("category distribution:", byCategory);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  ensureTable(db);

  const before = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
  console.log(`existing rows in timeline_events: ${before} (will be wiped)`);

  const insert = db.prepare(`
    INSERT INTO timeline_events (year, reign, reign_year_text, description, category, scale, source_line)
    VALUES (@year, @reign, @reignYearText, @description, @category, @scale, @sourceLine)
  `);

  const tx = db.transaction((rows) => {
    db.prepare("DELETE FROM timeline_events").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name='timeline_events'").run();
    for (const r of rows) insert.run(r);
  });
  tx(events);

  const after = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
  console.log(`inserted ${after} rows`);
  db.close();
  console.log("done.");
}

main();
