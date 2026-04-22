/**
 * Splits an array into chunks of a specified size.
 * @param {Array} arr - The array to split.
 * @param {number} size - The chunk size.
 * @returns {Array[]} Array of chunks.
 */
function chunks(arr, size) {
    if (!Array.isArray(arr) || size < 1) return [];
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}
exports.chunks = chunks;
/**
 * 西南科技大学课表插件
 */

exports.meta = {
    name: "西南科技大学",
    version: "2.1.0",
    description: "手机号+短信验证码登录获取课表",
    author: "Schedule App",
    inputs: [
        { key: "phone", label: "手机号", type: "text", required: true },
        { key: "smsCode", label: "验证码", type: "password", required: true },
    ],
    buttons: [
        { key: "Get_Sms_Code", label: "发送验证码" },
        { key: "login", label: "登录获取课表" },
    ],
};

const CAS_URL = "https://cas.swust.edu.cn/authserver/login";
const CAS_SERVICE_MAIN = "https://matrix.dean.swust.edu.cn/acadmicManager/index.cfm?event=studentPortal:DEFAULT_EVENT";
const CAS_SERVICE_EXP = "https://sjjx.dean.swust.edu.cn/swust/";
const EXP_INDEX_URL = "https://sjjx.dean.swust.edu.cn/aexp/stuIndex.jsp";
const TIMETABLE_URL = "https://matrix.dean.swust.edu.cn/acadmicManager/index.cfm?event=studentPortal:courseTable";
const EXP_API = "https://sjjx.dean.swust.edu.cn/teachn/teachnAction/index.action";


const LECTURE_TIME = { 1: { s: "08:00", e: "09:40" }, 2: { s: "10:00", e: "11:40" }, 3: { s: "14:00", e: "15:40" }, 4: { s: "16:00", e: "17:40" }, 5: { s: "19:00", e: "20:40" } };
const SECTION_TIME = { 1: "08:00", 2: "08:50", 3: "10:00", 4: "10:50", 5: "14:00", 6: "14:50", 7: "16:00", 8: "16:50", 9: "19:00", 10: "19:50", 11: "20:40", 12: "21:30" };
const DAY_MAP = { "一": "Mon", "二": "Tue", "三": "Wed", "四": "Thu", "五": "Fri", "六": "Sat", "日": "Sun" };

const extractExec = (h) => (h.match(/name="execution"\s+value="([^"]+)"/i) || [])[1] || "";
const stripTag = (s) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
const buildForm = (d) => new URLSearchParams(d).toString();
const normalizeText = (s) => stripTag(s).replace(/\s+/g, " ").trim();
const decodeHtml = (s) => s.replace(/&amp;/g, "&");

function addMinutes(time, minutes) {
    const [hours, mins] = time.split(":").map(Number);
    const total = hours * 60 + mins + minutes;
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return `${hh}:${mm}`;
}

function getSectionEndTime(section) {
    const currentStart = SECTION_TIME[section];
    return currentStart ? addMinutes(currentStart, 50) : "09:40";
}

async function casLogin(ctx, service, phone, code, log) {
    const url = `${CAS_URL}?service=${encodeURIComponent(service)}`;
    log(`[CAS] 获取登录页: ${service === CAS_SERVICE_MAIN ? "主系统" : "实验课系统"}`);

    const page = await ctx.http.get(url, { withCredentials: true });
    const exec = extractExec(page.data);

    if (!exec) {
        log("[CAS] 已有会话，跳过登录");
        return true;
    }

    log(`[CAS] execution: ${exec.substring(0, 10)}...`);

    const payload = { execution: exec, _eventId: "submit", username: phone, mobile: phone, lm: "dynamicLogin", dynamicCode: code, smsCode: code, type: "mobile", loginType: "dynamic" };
    const res = await ctx.http.post(url, buildForm(payload), { withCredentials: true, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: url } });
    const txt = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

    const success = txt.includes("studentPortal") || txt.includes("实验") || txt.includes("swust");
    log(`[CAS] 登录${success ? "成功" : "失败"}`);
    return success;
}

function parseMainCourse(html, log) {
    const NumberMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
    log("[主课表] 开始解析");
    const events = [];
    const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let count = 0;

    for (const tr of trs) {
        const tds = tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
        let lecture = null;
        for (const td of tds) {
            const m = stripTag(td).match(/第\s*(一|二|三|四|五|六|七|八|九|十)\s*讲/);
            if (m) { lecture = NumberMap[m[1]]; break; }
        }
        if (!lecture) continue;

        const time = LECTURE_TIME[lecture] || { s: "08:00", e: "09:40" };
        const hasMarker = /上午|下午|晚上/.test(stripTag(tds[0]));
        const offset = hasMarker ? 2 : 1;

        for (let i = offset; i < tds.length && i - offset < 7; i++) {
            const txt = stripTag(tds[i]);
            if (txt.length < 5) continue;
            const lines = txt.split(/\n/).map(l => l.trim()).filter(Boolean);
            if (lines.length < 1) continue;
            for (const line of chunks(ByteLengthQueuingStrategy, 3)) {

                let [name, teacher] = line[0].split(/\s*[-–—]\s*/);
                const weeks = line[1] ? (line[1].match(/\d+-\d+/g) || []).map(w => {
                    const [start, end] = w.split('-').map(Number);
                    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
                }).flat() : undefined;
                const loc = line[2];

                events.push({ id: `swust-${lecture}-${i}`, title: name, day: days[i - offset], start: time.s, end: time.e, location: loc, teacher, weeks });
                count++;
            }
        }
    }
    log(`[主课表] 解析到 ${count} 个课程`);
    return events;
}
exports.parseMainCourse = parseMainCourse;
exports.parseMainCourse = parseMainCourse;
function isExpLoginPage(html) {
    return /authserver|name="execution"|统一身份认证|登录/i.test(html);
}

function isExpUnauthorizedPage(html) {
    return /self\.location=['"]\/aexp['"]|alert\s*\(|越权|请先登录|login timeout|登录超时/i.test(html);
}

function looksLikeExpTable(html) {
    return /课程名称/.test(html) && /上课时间/.test(html) && /teachnAction\/index\.action/.test(html);
}

function getExpQueryParams(html) {
    const match = html.match(/teachnAction\/index\.action\?([^"'#\s>]+)/i);
    if (!match) return {};

    const params = new URLSearchParams(decodeHtml(match[1]));
    const keep = ["currTeachCourseCode", "currWeek", "currYearterm"];
    return keep.reduce((acc, key) => {
        if (params.has(key)) acc[key] = params.get(key) || "";
        return acc;
    }, {});
}

function buildExpPageUrl(page, extraParams = {}) {
    const params = new URLSearchParams({ "page.pageNum": String(page) });
    Object.entries(extraParams).forEach(([key, value]) => params.set(key, value));
    return `${EXP_API}?${params.toString()}`;
}

function getExpNextPageUrl(html) {
    const match = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*下一页\s*<\/a>/i);
    if (!match) return "";

    const href = decodeHtml(match[1]).trim();
    if (!href) return "";

    try {
        return new URL(href, EXP_API).toString();
    } catch (_) {
        return href;
    }
}

function parseExpTime(timeStr) {
    const normalized = timeStr.replace(/\s+/g, "").replace(/[()（）]/g, "").replace(/至/g, "-");
    const match = normalized.match(/第?(\d+)周星期([一二三四五六日天])第?(\d+)(?:[-~](\d+))?节/);
    if (!match) return null;

    const week = Number(match[1]);
    const day = DAY_MAP[match[2] === "天" ? "日" : match[2]];
    const startSection = Number(match[3]);
    const endSection = match[4] ? Number(match[4]) : startSection;

    return {
        week,
        day,
        startSection,
        endSection,
    };
}

function parseExpCoursePage(html, log, seen) {
    const events = [];

    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => normalizeText(m[1]));
        if (cells.length < 5) continue;

        const [courseName, itemName, timeStr, loc, teacher] = cells;
        if (!courseName || !timeStr || courseName === "课程名称") continue;

        const parsedTime = parseExpTime(timeStr);
        if (!parsedTime) {
            log(`[实验课] 时间格式无法解析: ${timeStr}`);
            continue;
        }

        const { week, day, startSection, endSection } = parsedTime;
        const dedupeKey = [courseName, itemName, week, day, startSection, endSection, loc, teacher].join("|");
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const title = itemName ? `${courseName} - ${itemName}` : courseName;
        events.push({
            id: `exp-${week}-${day}-${startSection}-${events.length}`,
            title,
            day,
            start: SECTION_TIME[startSection] || "08:00",
            end: getSectionEndTime(endSection),
            location: loc,
            teacher,
            weeks: [week],
        });
    }

    return events;
}
exports.parseExpCoursePage = parseExpCoursePage;
async function requestExpPage(ctx, url) {
    return ctx.http.get(url, {
        withCredentials: true,
        headers: { Referer: EXP_INDEX_URL, "User-Agent": "Mozilla/5.0" },
    });
}

async function fetchPageViaCasService(ctx, targetUrl, phone, smsCode, log, label) {
    const casUrl = `${CAS_URL}?service=${encodeURIComponent(targetUrl)}`;
    log(`[实验课] CAS service获取(${label}): ${targetUrl}`);

    const page = await ctx.http.get(casUrl, { withCredentials: true });
    const html = typeof page.data === "string" ? page.data : JSON.stringify(page.data);
    log(`[实验课] CAS service响应长度: ${html.length}`);

    const execution = extractExec(html);
    if (!execution) return html;

    const payloads = [
        { execution, _eventId: "submit", username: phone, mobile: phone, lm: "dynamicLogin", dynamicCode: smsCode, code: smsCode, smsCode, type: "mobile", loginType: "dynamic", rememberMe: "true" },
        { execution, _eventId: "submit", username: phone, mobile: phone, dynamicCode: smsCode, code: smsCode, smsCode, loginType: "dynamic" },
    ];

    for (let i = 0; i < payloads.length; i++) {
        try {
            log(`[实验课] CAS service登录 ${i + 1}/${payloads.length}`);
            const res = await ctx.http.post(casUrl, buildForm(payloads[i]), {
                withCredentials: true,
                headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: casUrl },
            });
            const txt = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            log(`[实验课] CAS service登录响应长度: ${txt.length}`);
            if (!isExpLoginPage(txt)) return txt;
        } catch (e) {
            log(`[实验课] CAS service登录失败: ${e.message}`);
        }
    }

    return html;
}

async function prepareExpSession(ctx, log) {
    for (const url of [
        "https://sjjx.dean.swust.edu.cn/aexp/login.jsp",
        CAS_SERVICE_EXP,
        EXP_INDEX_URL,
    ]) {
        try {
            await requestExpPage(ctx, url);
        } catch (e) {
            log(`[实验课] 预请求失败: ${url} -> ${e.message}`);
        }
    }
}

async function fetchExpCourse(ctx, phone, smsCode, log) {
    log("[实验课] 预请求建立会话...");
    await prepareExpSession(ctx, log);

    const events = [];
    const seen = new Set();
    let page = 1;
    let total = 1;
    let extraParams = {};
    let currentUrl = buildExpPageUrl(page, extraParams);
    let retried = false;

    do {
        const url = currentUrl || buildExpPageUrl(page, extraParams);
        log(`[实验课] 获取第 ${page} 页`);

        let html = "";
        try {
            const res = await requestExpPage(ctx, url);
            html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        } catch (e) {
            log(`[实验课] 直接访问失败: ${e.message}`);
        }

        if (!html || isExpLoginPage(html) || isExpUnauthorizedPage(html)) {
            html = await fetchPageViaCasService(ctx, url, phone, smsCode, log, `page-${page}`);
        }

        if (isExpLoginPage(html) || isExpUnauthorizedPage(html)) {
            if (retried) throw new Error("实验课系统返回未登录页面");
            retried = true;
            await prepareExpSession(ctx, log);
            html = await fetchPageViaCasService(ctx, url, phone, smsCode, log, `page-${page}-retry`);
            if (isExpLoginPage(html) || isExpUnauthorizedPage(html)) continue;
        }

        if (!looksLikeExpTable(html)) {
            log(`[实验课] 未识别为实验课表页面，响应片段: ${normalizeText(html).slice(0, 120)}`);
            if (page === 1) return [];
            break;
        }

        if (page === 1) {
            const m = html.match(/第\s*\d+\s*页\s*\/\s*共\s*(\d+)\s*页/);
            if (m) {
                total = Number(m[1]);
                log(`[实验课] 共 ${total} 页`);
            }
            extraParams = getExpQueryParams(html);
            if (Object.keys(extraParams).length) {
                log(`[实验课] 继承分页参数: ${JSON.stringify(extraParams)}`);
            }
        }

        const pageEvents = parseExpCoursePage(html, log, seen);
        events.push(...pageEvents);
        log(`[实验课] 第 ${page} 页解析 ${pageEvents.length} 个课程`);

        const nextPageUrl = getExpNextPageUrl(html);
        if (nextPageUrl) {
            log(`[实验课] 发现下一页链接: ${nextPageUrl}`);
        }

        page++;
        currentUrl = nextPageUrl || buildExpPageUrl(page, extraParams);
        retried = false;
    } while (page <= total && page <= 20);

    log(`[实验课] 共 ${events.length} 个课程`);
    return events;
}

exports.run = async (ctx) => {
    const { phone, smsCode } = ctx.config;
    const log = (m) => ctx.log(m);

    log(`========== SWUST Plugin v2.1.0 ==========`);
    log(`手机号: ${phone}`);

    if (!phone || !/^\d{11}$/.test(phone)) {
        log("错误: 手机号格式不正确");
        return { events: [], debug: { error: "手机号格式错误" } };
    }

    // Send SMS
    if (ctx.hasButton("Get_Sms_Code")) {
        log(">>> 发送验证码模式 <<<");
        const url = `${CAS_URL}?service=${encodeURIComponent(CAS_SERVICE_MAIN)}`;
        const page = await ctx.http.get(url, { withCredentials: true });
        const exec = extractExec(page.data);
        log(`execution: ${exec || "(空)"}`);

        for (const ep of ["/authserver/getDynamicCode", "/authserver/sendDynamicCode"]) {
            log(`尝试端点: ${ep}`);
            try {
                const res = await ctx.http.post(`https://cas.swust.edu.cn${ep}`, buildForm({ mobile: phone, phone, username: phone, execution: exec, _eventId: "send", type: "mobile" }), { withCredentials: true, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
                if (res.status === 200) {
                    ctx.storage.set("swust_phone", phone);
                    log("验证码发送成功");
                    return { events: [], debug: { smsSent: true } };
                }
            } catch (e) {
                log(`端点失败: ${e.message}`);
            }
        }
        log("验证码发送失败");
        return { events: [], debug: { error: "发送失败" } };
    }

    // Login
    if (ctx.hasButton("login")) {
        log(">>> 登录获取课表模式 <<<");

        if (!smsCode) {
            log("错误: 未输入验证码");
            return { events: [], debug: { error: "请输入验证码" } };
        }

        ctx.storage.set("swust_phone", phone);
        ctx.storage.set("swust_sms_code", smsCode);

        // Login to main system
        if (!await casLogin(ctx, CAS_SERVICE_MAIN, phone, smsCode, log)) {
            return { events: [], debug: { error: "主系统登录失败" } };
        }

        // Fetch main courses
        log(">>> 获取主课表 <<<");
        const res = await ctx.http.get(TIMETABLE_URL, { withCredentials: true });
        const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        log(`课表页长度: ${html.length}`);

        const mainEvents = parseMainCourse(html, log);

        // Fetch experiment courses
        log(">>> 获取实验课表 <<<");
        let expEvents = [];
        try {
            expEvents = await fetchExpCourse(ctx, phone, smsCode, log);
        } catch (e) {
            log(`[实验课] 获取失败: ${e.message}`);
        }

        // Extract term start date
        const termMatch = html.match(/(\d{4})-(\d{4})[学年\-]?\s*(春|秋|1|2)/);
        let startDate = "2026-03-02";
        if (termMatch) {
            const y = parseInt(termMatch[1]);
            const t = termMatch[3];
            startDate = (t === "春" || t === "2") ? `${y + 1}-03-02` : `${y}-09-01`;
        }

        log(`========== 完成 ==========`);
        log(`主课表: ${mainEvents.length} 个`);
        log(`实验课: ${expEvents.length} 个`);
        log(`总计: ${mainEvents.length + expEvents.length} 个课程`);

        return { events: [...mainEvents, ...expEvents], configurations: { "start-time": [startDate], "script-name": "西南科技大学" } };
    }

    return { events: [], debug: { error: "未知操作" } };
};
