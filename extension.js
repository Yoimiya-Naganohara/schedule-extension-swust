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
const TIMETABLE_URL = "https://matrix.dean.swust.edu.cn/acadmicManager/index.cfm?event=studentPortal:courseTable";
const EXP_API = "https://sjjx.dean.swust.edu.cn/teachn/teachnAction/index.action";

const LECTURE_TIME = { 1: { s: "08:00", e: "09:40" }, 2: { s: "10:00", e: "11:40" }, 3: { s: "14:00", e: "15:40" }, 4: { s: "16:00", e: "17:40" }, 5: { s: "19:00", e: "20:40" } };
const SECTION_TIME = { 1: "08:00", 2: "08:50", 3: "10:00", 4: "10:50", 5: "14:00", 6: "14:50", 7: "16:00", 8: "16:50", 9: "19:00", 10: "19:50", 11: "20:40", 12: "21:30" };
const DAY_MAP = { "一": "Mon", "二": "Tue", "三": "Wed", "四": "Thu", "五": "Fri", "六": "Sat", "日": "Sun" };

const extractExec = (h) => (h.match(/name="execution"\s+value="([^"]+)"/i) || [])[1] || "";
const stripTag = (s) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
const buildForm = (d) => new URLSearchParams(d).toString();

async function casLogin(ctx, service, phone, code, log) {
    const url = `${CAS_URL}?service=${encodeURIComponent(service)}`;
    const page = await ctx.http.get(url, { withCredentials: true });
    const exec = extractExec(page.data);
    if (!exec) return true; // Already logged in

    const payload = { execution: exec, _eventId: "submit", username: phone, mobile: phone, lm: "dynamicLogin", dynamicCode: code, smsCode: code, type: "mobile", loginType: "dynamic" };
    const res = await ctx.http.post(url, buildForm(payload), { withCredentials: true, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: url } });
    const txt = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return txt.includes("studentPortal") || txt.includes("实验") || txt.includes("swust");
}

function parseMainCourse(html) {
    const events = [];
    const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    for (const tr of trs) {
        const tds = tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
        let lecture = null;
        for (const td of tds) {
            const m = stripTag(td).match(/第\s*(\d+)\s*讲/);
            if (m) { lecture = Number(m[1]); break; }
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

            let [name, teacher] = lines[0].split(/\s*[-–—]\s*/);
            const weeks = lines[1] ? (lines[1].match(/\d+/g) || []).map(Number) : undefined;
            const loc = lines[2];

            events.push({ id: `swust-${lecture}-${i}`, title: name, day: days[i - offset], start: time.s, end: time.e, location: loc, teacher, weeks });
        }
    }
    return events;
}

async function fetchExpCourse(ctx, log) {
    // Pre-request to establish session
    await ctx.http.get("https://sjjx.dean.swust.edu.cn/swust", { withCredentials: true }).catch(() => { });

    const events = [];
    let page = 1, total = 1;

    do {
        const res = await ctx.http.get(`${EXP_API}?page.pageNum=${page}`, { withCredentials: true });
        const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

        if (page === 1) {
            const m = html.match(/第\s*\d+\s*页\s*\/\s*共\s*(\d+)\s*页/);
            if (m) total = Number(m[1]);
        }

        for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTag(m[1]));
            if (cells.length < 5) continue;

            const [name, , timeStr, loc, teacher] = cells;
            const m = timeStr.match(/(\d+)周星期([一二三四五六日])(\d+)[-~]?(\d*)节/);
            if (!m) continue;

            const week = Number(m[1]), day = DAY_MAP[m[2]], start = Number(m[3]), end = m[4] ? Number(m[4]) : start;
            events.push({ id: `exp-${week}-${day}-${start}`, title: name, day, start: SECTION_TIME[start] || "08:00", end: SECTION_TIME[end + 1] || "09:40", location: loc, teacher, weeks: [week] });
        }
        page++;
    } while (page <= total && page <= 20);

    return events;
}

exports.run = async (ctx) => {
    const { phone, smsCode } = ctx.config;
    const log = (m) => ctx.log(m);

    log(`SWUST Plugin v2.1.0 - ${phone}`);

    if (!phone || !/^\d{11}$/.test(phone)) return { events: [], debug: { error: "手机号格式错误" } };

    // Send SMS
    if (ctx.hasButton("Get_Sms_Code")) {
        const url = `${CAS_URL}?service=${encodeURIComponent(CAS_SERVICE_MAIN)}`;
        const page = await ctx.http.get(url, { withCredentials: true });
        const exec = extractExec(page.data);

        for (const ep of ["/authserver/getDynamicCode", "/authserver/sendDynamicCode"]) {
            try {
                const res = await ctx.http.post(`https://cas.swust.edu.cn${ep}`, buildForm({ mobile: phone, phone, username: phone, execution: exec, _eventId: "send", type: "mobile" }), { withCredentials: true, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
                if (res.status === 200) {
                    ctx.storage.set("swust_phone", phone);
                    return { events: [], debug: { smsSent: true } };
                }
            } catch (e) { }
        }
        return { events: [], debug: { error: "发送失败" } };
    }

    // Login
    if (ctx.hasButton("login")) {
        if (!smsCode) return { events: [], debug: { error: "请输入验证码" } };

        ctx.storage.set("swust_phone", phone);
        ctx.storage.set("swust_sms_code", smsCode);

        // Login to main system
        if (!await casLogin(ctx, CAS_SERVICE_MAIN, phone, smsCode, log)) {
            return { events: [], debug: { error: "主系统登录失败" } };
        }

        // Login to experiment system
        await casLogin(ctx, CAS_SERVICE_EXP, phone, smsCode, log);

        // Fetch main courses
        const res = await ctx.http.get(TIMETABLE_URL, { withCredentials: true });
        const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        const mainEvents = parseMainCourse(html);

        // Fetch experiment courses
        const expEvents = await fetchExpCourse(ctx, log);

        // Extract term start date
        const termMatch = html.match(/(\d{4})-(\d{4})[学年\-]?\s*(春|秋|1|2)/);
        let startDate = "2026-03-08";
        if (termMatch) {
            const y = parseInt(termMatch[1]);
            const t = termMatch[3];
            startDate = (t === "春" || t === "2") ? `${y + 1}-03-01` : `${y}-09-01`;
        }

        log(`获取 ${mainEvents.length} 个课程 + ${expEvents.length} 个实验课`);
        return { events: [...mainEvents, ...expEvents], configurations: { "start-time": [startDate], "script-name": "西南科技大学" } };
    }

    return { events: [], debug: { error: "未知操作" } };
};
