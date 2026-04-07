/**
 * 西南科技大学课表插件
 *
 * 使用手机号+短信验证码登录获取课表
 */

exports.meta = {
    name: "西南科技大学",
    version: "2.0.0",
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

const CAS_LOGIN_URL = "https://cas.swust.edu.cn/authserver/login?service=https%3A%2F%2Fmatrix.dean.swust.edu.cn%2FacadmicManager%2Findex.cfm%3Fevent%3DstudentPortal%3ADEFAULT_EVENT";
const CAS_EXPERIMENT_LOGIN_URL = "https://cas.swust.edu.cn/authserver/login?service=https%3A%2F%2Fsjjx.dean.swust.edu.cn%2Fswust%2F";
const TIMETABLE_URL = "https://matrix.dean.swust.edu.cn/acadmicManager/index.cfm?event=studentPortal:courseTable";
const EXPERIMENT_COURSE_API = "https://sjjx.dean.swust.edu.cn/teachn/teachnAction/index.action";
const BASE_ORIGIN = new URL(CAS_LOGIN_URL).origin;

const SECTION_TIME_MAP = {
    1: "08:00", 2: "08:50", 3: "10:00", 4: "10:50",
    5: "14:00", 6: "14:50", 7: "16:00", 8: "16:50",
    9: "19:00", 10: "19:50", 11: "20:40", 12: "21:30",
};

const LECTURE_TIME_MAP = {
    1: { start: "08:00", end: "09:40" }, 2: { start: "10:00", end: "11:40" },
    3: { start: "14:00", end: "15:40" }, 4: { start: "16:00", end: "17:40" },
    5: { start: "19:00", end: "20:40" }, 6: { start: "20:50", end: "22:30" },
};

// Chinese numeral to number mapping
const CHINESE_NUM_MAP = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "十一": 11, "十二": 12,
};

const DAY_CN_MAP = {
    "周一": "Mon", "周二": "Tue", "周三": "Wed", "周四": "Thu",
    "周五": "Fri", "周六": "Sat", "周日": "Sun", "周天": "Sun",
    "星期一": "Mon", "星期二": "Tue", "星期三": "Wed", "星期四": "Thu",
    "星期五": "Fri", "星期六": "Sat", "星期日": "Sun", "星期天": "Sun",
};

function parseLectureNumber(txt) {
    const s = String(txt ?? "").trim();
    // Try "第1讲" format (Arabic numeral)
    let m = s.match(/第\s*(\d+)\s*讲/);
    if (m) return Number(m[1]);
    // Try "第一讲" format (Chinese numeral)
    m = s.match(/第\s*([一二三四五六七八九十]+)\s*讲/);
    if (m && CHINESE_NUM_MAP[m[1]]) return CHINESE_NUM_MAP[m[1]];
    return null;
}

function parseSectionTime(txt) {
    const s = String(txt ?? "").trim();
    // Try "第1节" or "第1-2节" format
    let m = s.match(/第\s*(\d+)\s*[-~至]?\s*(\d*)\s*节/);
    if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : start;
        return { start, end };
    }
    // Try Chinese numeral format "第一节"
    m = s.match(/第\s*([一二三四五六七八九十]+)\s*[-~至]?\s*([一二三四五六七八九十]*)\s*节/);
    if (m) {
        const start = CHINESE_NUM_MAP[m[1]] || 1;
        const end = m[2] ? (CHINESE_NUM_MAP[m[2]] || start) : start;
        return { start, end };
    }
    return null;
}

function parseExperimentWeeks(txt) {
    const s = String(txt ?? "").trim();
    if (!s) return undefined;
    const weeks = new Set();
    // Match "第X周" or "X周" patterns
    for (const m of s.matchAll(/第?\s*(\d{1,2})\s*周/g)) {
        weeks.add(Number(m[1]));
    }
    // Match "X-Y周" range patterns
    let rangeMatch = s.match(/(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*周/);
    if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        for (let i = start; i <= end; i++) weeks.add(i);
    }
    return weeks.size > 0 ? [...weeks].sort((a, b) => a - b) : undefined;
}

// Parse experiment course time format: "1周星期二11-12节" or "2周星期四5-8节"
function parseExperimentTime(txt, debug) {
    const s = String(txt ?? "").trim();
    if (!s) return null;

    // Pattern: 周次星期X节次
    // e.g., "1周星期二11-12节", "2周星期四5-8节"
    const match = s.match(/(\d+)周星期([一二三四五六日])(\d+)[-~至]?(\d*)节/);
    if (!match) {
        debug(`[parseExperimentTime] 无法解析: ${s}`);
        return null;
    }

    const week = Number(match[1]);
    const dayCn = match[2];
    const startSection = Number(match[3]);
    const endSection = match[4] ? Number(match[4]) : startSection;

    const dayMap = { "一": "Mon", "二": "Tue", "三": "Wed", "四": "Thu", "五": "Fri", "六": "Sat", "日": "Sun" };
    const day = dayMap[dayCn] || "Mon";

    // Get time from section number
    const startTime = SECTION_TIME_MAP[startSection] || "08:00";
    const endTime = SECTION_TIME_MAP[endSection] || SECTION_TIME_MAP[endSection + 1] || "09:40";

    return {
        week,
        day,
        startSection,
        endSection,
        startTime,
        endTime,
    };
}

// Utility functions
const extractExecution = (html) => {
    const m = String(html).match(/name="execution"\s+value="([^"]+)"/i);
    return m ? m[1] : "";
};

const buildForm = (data) => new URLSearchParams(data).toString();

const decodeHtml = (s) => String(s ?? "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const stripTags = (s) => decodeHtml(String(s ?? "").replace(/<[^>]*>/g, "")).trim();

const normalizeDay = (d) => {
    const map = {
        1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun",
        Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun",
        周一: "Mon", 周二: "Tue", 周三: "Wed", 周四: "Thu", 周五: "Fri", 周六: "Sat", 周日: "Sun",
    };
    return map[String(d ?? "").trim()] ?? "Mon";
};

const parseWeeks = (txt) => {
    const source = String(txt ?? "").trim();
    if (!source) return undefined;
    let m = source.match(/(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*[（(]?\s*(\d)\s*[）)]?/);
    if (!m) m = source.match(/(\d{1,2})\s*[-~至]\s*(\d{1,2})/);
    if (!m) return undefined;
    const start = Number(m[1]), end = Number(m[2]), mode = m[3] ? Number(m[3]) : 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
    const arr = [];
    for (let i = start; i <= end; i++) {
        if (mode === 1 && i % 2 === 0) continue;  // mode=1: odd weeks only
        arr.push(i);
    }
    return arr.length ? arr : undefined;
};

const extractTermStartDates = (html) => {
    const txt = String(html ?? "");
    
    // Try to extract term info like "2025-2026学年 春季学期" or "2025-2026-2 学期"
    // Spring term (春季学期/第二学期) starts in March of the second year
    // Fall term (秋季学期/第一学期) starts in September of the first year
    const termMatch = txt.match(/(\d{4})-(\d{4})[学年\-]?\s*(春|秋|第一|第二|1|2)/);
    if (termMatch) {
        const year1 = parseInt(termMatch[1]);
        const term = termMatch[3];
        // Spring term (春季/第二学期/2) starts in March of the second year
        // Fall term (秋季/第一学期/1) starts in September of the first year
        if (term === "春" || term === "第二" || term === "2") {
            // Spring semester starts first Monday of March
            const march1 = new Date(year1 + 1, 2, 1); // March 1st of second year
            const dayOfWeek = march1.getDay();
            const firstMonday = dayOfWeek === 1 ? 1 : (8 - dayOfWeek + 1);
            const startDate = new Date(year1 + 1, 2, firstMonday);
            const dateStr = startDate.toISOString().split('T')[0];
            return [dateStr];
        } else if (term === "秋" || term === "第一" || term === "1") {
            // Fall semester starts first Monday of September
            const sept1 = new Date(year1, 8, 1); // September 1st
            const dayOfWeek = sept1.getDay();
            const firstMonday = dayOfWeek === 1 ? 1 : (8 - dayOfWeek + 1);
            const startDate = new Date(year1, 8, firstMonday);
            const dateStr = startDate.toISOString().split('T')[0];
            return [dateStr];
        }
    }
    
    // Fallback: extract all dates and return sorted
    const dates = new Set();
    for (const m of txt.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
        dates.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
    return [...dates].sort();
};

// HTTP helpers using ctx.http
async function verifySession(ctx, debug) {
    debug("[verifySession] 开始验证会话");
    const testUrls = [
        "https://matrix.dean.swust.edu.cn/acadmicManager/index.cfm",
        `${BASE_ORIGIN}/authserver/index.do`,
    ];

    for (let i = 0; i < testUrls.length; i++) {
        const url = testUrls[i];
        debug(`[verifySession] 尝试 ${i + 1}/${testUrls.length}: ${url}`);
        try {
            const res = await ctx.http.get(url, { timeout: 12000, withCredentials: true });
            debug(`[verifySession] 状态: ${res.status}`);
            if (res.status === 200) {
                const content = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});
                const hasLoginForm = /(<form[^>]*login|name=["']username["'])/i.test(content);
                const hasAuthContent = /(studentPortal|个人中心|课程表)/i.test(content);
                debug(`[verifySession] hasLoginForm=${hasLoginForm}, hasAuthContent=${hasAuthContent}`);
                if (!hasLoginForm || hasAuthContent) {
                    debug("[verifySession] ✓ 会话有效");
                    return true;
                }
            }
        } catch (e) {
            debug(`[verifySession] ✗ 请求失败: ${String(e)}`);
        }
    }
    debug("[verifySession] ✗ 会话无效");
    return false;
}

async function sendSmsCode(ctx, phone, debug) {
    debug("[sendSmsCode] 开始发送验证码");
    debug(`[sendSmsCode] 手机号: ${phone}`);

    debug("[sendSmsCode] 获取CAS登录页...");
    const loginPage = await ctx.http.get(CAS_LOGIN_URL, { timeout: 15000, withCredentials: true });
    debug(`[sendSmsCode] CAS页状态: ${loginPage.status}`);

    const execution = extractExecution(loginPage.data);
    debug(`[sendSmsCode] execution: ${execution || "(空)"}`);

    const endpoints = [
        `${BASE_ORIGIN}/authserver/getDynamicCode`,
        `${BASE_ORIGIN}/authserver/sendDynamicCode`,
        `${BASE_ORIGIN}/authserver/mobile/sendCode`,
    ];

    for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        debug(`[sendSmsCode] 尝试端点 ${i + 1}/${endpoints.length}: ${endpoint}`);
        try {
            const res = await ctx.http.post(endpoint, buildForm({
                mobile: phone, phone, username: phone, execution,
                _eventId: "send", type: "mobile", loginType: "dynamic",
            }), {
                timeout: 12000,
                withCredentials: true,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Referer: CAS_LOGIN_URL,
                },
            });
            debug(`[sendSmsCode] 状态: ${res.status}`);
            const data = res.data;
            const preview = typeof data === "string" ? data.slice(0, 100) : JSON.stringify(data).slice(0, 100);
            debug(`[sendSmsCode] 响应预览: ${preview}`);

            const success = typeof data === "string"
                ? (data.includes("发送成功") || data.toLowerCase().includes("success"))
                : (data.success === true || data.code === 200);
            debug(`[sendSmsCode] 判断成功: ${success}`);

            if (success || res.status === 200) {
                debug("[sendSmsCode] ✓ 验证码发送成功");
                return true;
            }
        } catch (e) {
            debug(`[sendSmsCode] ✗ 端点失败: ${String(e)}`);
        }
    }
    debug("[sendSmsCode] ✗ 所有端点都失败");
    return false;
}

async function login(ctx, phone, smsCode, debug) {
    debug("[login] 开始登录");
    debug(`[login] 手机号: ${phone}`);

    debug("[login] 获取CAS登录页...");
    const loginPage = await ctx.http.get(CAS_LOGIN_URL, { timeout: 15000, withCredentials: true });
    debug(`[login] CAS页状态: ${loginPage.status}`);

    const execution = extractExecution(loginPage.data);
    debug(`[login] execution: ${execution || "(空)"}`);

    const payloads = [
        { execution, _eventId: "submit", username: phone, mobile: phone,
          lm: "dynamicLogin", dynamicCode: smsCode, code: smsCode, smsCode,
          type: "mobile", loginType: "dynamic", rememberMe: "true" },
        { execution, _eventId: "submit", username: phone, mobile: phone,
          dynamicCode: smsCode, code: smsCode, smsCode, loginType: "dynamic" },
    ];

    for (let i = 0; i < payloads.length; i++) {
        debug(`[login] 尝试 payload ${i + 1}/${payloads.length}`);
        try {
            const res = await ctx.http.post(CAS_LOGIN_URL, buildForm(payloads[i]), {
                timeout: 15000,
                withCredentials: true,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Referer: CAS_LOGIN_URL,
                },
            });
            debug(`[login] 状态: ${res.status}`);
            const txt = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});
            const preview = txt.slice(0, 200);
            debug(`[login] 响应预览: ${preview}`);

            const success = res.status === 301 || res.status === 302 ||
                txt.includes("登录成功") || txt.toLowerCase().includes("success") ||
                txt.toLowerCase().includes("studentportal");
            debug(`[login] 判断成功: ${success}`);

            if (success) {
                debug("[login] ✓ 登录成功");
                return true;
            }
        } catch (e) {
            debug(`[login] ✗ payload失败: ${String(e)}`);
        }
    }
    debug("[login] ✗ 所有payload都失败");
    return false;
}

// Login to experiment system via CAS
async function loginExperiment(ctx, debug) {
    debug("[loginExperiment] 开始登录实验课系统");

    // Step 1: First, visit the experiment system login page to establish session
    debug("[loginExperiment] 步骤1: 访问实验课登录页面建立会话...");
    const expLoginUrl = "https://sjjx.dean.swust.edu.cn/aexp/login.jsp";
    try {
        const loginPageRes = await ctx.http.get(expLoginUrl, { timeout: 15000, withCredentials: true });
        debug(`[loginExperiment] 登录页状态: ${loginPageRes.status}`);
        const loginPageTxt = typeof loginPageRes.data === "string" ? loginPageRes.data : JSON.stringify(loginPageRes.data ?? {});
        debug(`[loginExperiment] 登录页长度: ${loginPageTxt.length}`);
    } catch (e) {
        debug(`[loginExperiment] 访问登录页失败: ${String(e)}`);
    }

    // Step 2: Try CAS login for experiment system
    debug("[loginExperiment] 步骤2: 通过 CAS service URL 访问实验课系统...");
    const casPage = await ctx.http.get(CAS_EXPERIMENT_LOGIN_URL, { timeout: 15000, withCredentials: true });
    debug(`[loginExperiment] CAS页状态: ${casPage.status}`);

    const casTxt = typeof casPage.data === "string" ? casPage.data : JSON.stringify(casPage.data ?? {});
    debug(`[loginExperiment] CAS响应长度: ${casTxt.length}`);
    debug(`[loginExperiment] CAS响应预览: ${casTxt.substring(0, 200)}...`);

    // Check if we got the experiment page (CAS auto-redirect)
    if (casTxt.includes("实验") || casTxt.includes("实践教学") || casTxt.includes("swust")) {
        if (!casTxt.includes("login.jsp") && !casTxt.includes("login")) {
            debug("[loginExperiment] ✓ CAS 自动登录成功，已跳转到实验课系统");
            return true;
        }
    }

    // Check if CAS needs login (has execution token)
    const execution = extractExecution(casTxt);
    debug(`[loginExperiment] CAS execution: ${execution || "(空)"}`);

    if (execution) {
        // CAS needs re-authentication - try with stored credentials
        const storedPhone = await ctx.storage.get("swust_phone");
        const storedSmsCode = await ctx.storage.get("swust_sms_code");

        if (!storedPhone || !storedSmsCode) {
            debug("[loginExperiment] ⚠ CAS 需要登录，但没有存储的凭据");
            return false;
        }

        debug(`[loginExperiment] 使用存储的凭据登录 CAS: ${storedPhone}`);

        const payloads = [
            { execution, _eventId: "submit", username: storedPhone, mobile: storedPhone,
              lm: "dynamicLogin", dynamicCode: storedSmsCode, code: storedSmsCode, smsCode: storedSmsCode,
              type: "mobile", loginType: "dynamic", rememberMe: "true" },
            { execution, _eventId: "submit", username: storedPhone, mobile: storedPhone,
              dynamicCode: storedSmsCode, code: storedSmsCode, smsCode: storedSmsCode, loginType: "dynamic" },
        ];

        for (let i = 0; i < payloads.length; i++) {
            debug(`[loginExperiment] 尝试 CAS payload ${i + 1}/${payloads.length}`);
            try {
                const res = await ctx.http.post(CAS_EXPERIMENT_LOGIN_URL, buildForm(payloads[i]), {
                    timeout: 15000,
                    withCredentials: true,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Referer: CAS_EXPERIMENT_LOGIN_URL,
                    },
                });
                debug(`[loginExperiment] CAS登录状态: ${res.status}`);
                const respTxt = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});

                if (respTxt.includes("实验") || respTxt.includes("实践教学") || respTxt.includes("swust")) {
                    debug("[loginExperiment] ✓ CAS 登录成功，已跳转到实验课系统");
                    return true;
                }
            } catch (e) {
                debug(`[loginExperiment] ✗ CAS payload失败: ${String(e)}`);
            }
        }
    }

    // Step 3: Check if we got a JS redirect or login timeout error
    const jsRedirectMatch = casTxt.match(/(?:window\.location|self\.location)\s*=\s*["']([^"']+)["']/);
    const alertMatch = casTxt.match(/alert\s*\(\s*["']([^"']+)["']\s*\)/);
    
    if (alertMatch) {
        debug(`[loginExperiment] 检测到提示: ${alertMatch[1]}`);
    }
    
    if (casTxt.includes("登录超时") || casTxt.includes("请重新登录") || casTxt.includes("timeout")) {
        debug("[loginExperiment] 步骤3: 检测到登录超时，需要重新进行CAS认证...");
        
        // Get fresh CAS login page for experiment system
        const freshCasUrl = CAS_EXPERIMENT_LOGIN_URL;
        debug(`[loginExperiment] 获取新的CAS登录页: ${freshCasUrl}`);
        
        try {
            const freshCasRes = await ctx.http.get(freshCasUrl, { timeout: 15000, withCredentials: true });
            const freshCasTxt = typeof freshCasRes.data === "string" ? freshCasRes.data : JSON.stringify(freshCasRes.data ?? {});
            debug(`[loginExperiment] 新CAS页长度: ${freshCasTxt.length}`);
            
            const freshExecution = extractExecution(freshCasTxt);
            debug(`[loginExperiment] 新CAS execution: ${freshExecution || "(空)"}`);
            
            if (freshExecution) {
                // Get stored credentials
                const storedPhone = await ctx.storage.get("swust_phone");
                const storedSmsCode = await ctx.storage.get("swust_sms_code");
                
                if (!storedPhone || !storedSmsCode) {
                    debug("[loginExperiment] ⚠ 没有存储的凭据，无法重新登录");
                    return false;
                }
                
                debug(`[loginExperiment] 使用存储的凭据重新登录: ${storedPhone}`);
                
                const payloads = [
                    { execution: freshExecution, _eventId: "submit", username: storedPhone, mobile: storedPhone,
                      lm: "dynamicLogin", dynamicCode: storedSmsCode, code: storedSmsCode, smsCode: storedSmsCode,
                      type: "mobile", loginType: "dynamic", rememberMe: "true" },
                    { execution: freshExecution, _eventId: "submit", username: storedPhone, mobile: storedPhone,
                      dynamicCode: storedSmsCode, code: storedSmsCode, smsCode: storedSmsCode, loginType: "dynamic" },
                ];
                
                for (let i = 0; i < payloads.length; i++) {
                    debug(`[loginExperiment] 尝试重新登录 payload ${i + 1}/${payloads.length}`);
                    try {
                        const loginRes = await ctx.http.post(freshCasUrl, buildForm(payloads[i]), {
                            timeout: 15000,
                            withCredentials: true,
                            headers: {
                                "Content-Type": "application/x-www-form-urlencoded",
                                Referer: freshCasUrl,
                            },
                        });
                        const loginTxt = typeof loginRes.data === "string" ? loginRes.data : JSON.stringify(loginRes.data ?? {});
                        debug(`[loginExperiment] 重新登录响应长度: ${loginTxt.length}`);
                        
                        if (loginTxt.includes("实验") && !loginTxt.includes("login") && !loginTxt.includes("alert")) {
                            debug("[loginExperiment] ✓ 重新登录成功");
                            return true;
                        }
                        
                        // Check for redirect
                        if (loginTxt.includes("self.location") || loginTxt.includes("window.location")) {
                            const redirMatch = loginTxt.match(/(?:self|window)\.location\s*=\s*["']([^"']+)["']/);
                            if (redirMatch && !loginTxt.includes("alert")) {
                                debug(`[loginExperiment] 检测到重定向: ${redirMatch[1]}`);
                                // Follow the redirect
                                const redirUrl = redirMatch[1].startsWith("http") 
                                    ? redirMatch[1] 
                                    : `https://sjjx.dean.swust.edu.cn${redirMatch[1]}`;
                                const redirRes = await ctx.http.get(redirUrl, { timeout: 15000, withCredentials: true });
                                const redirTxt = typeof redirRes.data === "string" ? redirRes.data : JSON.stringify(redirRes.data ?? {});
                                if (redirTxt.includes("实验") && !redirTxt.includes("login")) {
                                    debug("[loginExperiment] ✓ 通过重定向访问成功");
                                    return true;
                                }
                            }
                        }
                    } catch (e) {
                        debug(`[loginExperiment] 重新登录失败: ${String(e)}`);
                    }
                }
            }
        } catch (e) {
            debug(`[loginExperiment] 获取新CAS页失败: ${String(e)}`);
        }
    } else if (jsRedirectMatch) {
        const redirectUrl = jsRedirectMatch[1];
        debug(`[loginExperiment] 步骤3: 检测到JS重定向: ${redirectUrl}`);
        
        // Handle relative URLs
        const fullRedirectUrl = redirectUrl.startsWith("http") 
            ? redirectUrl 
            : `https://sjjx.dean.swust.edu.cn/aexp/${redirectUrl}`;
        
        debug(`[loginExperiment] 访问重定向URL: ${fullRedirectUrl}`);
        try {
            const redirectRes = await ctx.http.get(fullRedirectUrl, { timeout: 15000, withCredentials: true });
            const redirectTxt = typeof redirectRes.data === "string" ? redirectRes.data : JSON.stringify(redirectRes.data ?? {});
            debug(`[loginExperiment] 重定向页长度: ${redirectTxt.length}`);
            debug(`[loginExperiment] 重定向页预览: ${redirectTxt.substring(0, 500)}...`);
            
            // Check if this is a CAS login page
            const redirectExecution = extractExecution(redirectTxt);
            if (redirectExecution) {
                debug(`[loginExperiment] 发现CAS登录页，execution: ${redirectExecution}`);
                // Try to login with stored credentials
                const storedPhone = await ctx.storage.get("swust_phone");
                const storedSmsCode = await ctx.storage.get("swust_sms_code");
                
                if (storedPhone && storedSmsCode) {
                    const payloads = [
                        { execution: redirectExecution, _eventId: "submit", username: storedPhone, mobile: storedPhone,
                          lm: "dynamicLogin", dynamicCode: storedSmsCode, code: storedSmsCode, smsCode: storedSmsCode,
                          type: "mobile", loginType: "dynamic", rememberMe: "true" },
                    ];
                    
                    for (let i = 0; i < payloads.length; i++) {
                        debug(`[loginExperiment] 尝试重定向页登录 ${i + 1}/${payloads.length}`);
                        try {
                            const loginRes = await ctx.http.post(fullRedirectUrl, buildForm(payloads[i]), {
                                timeout: 15000,
                                withCredentials: true,
                                headers: {
                                    "Content-Type": "application/x-www-form-urlencoded",
                                    Referer: fullRedirectUrl,
                                },
                            });
                            const loginTxt = typeof loginRes.data === "string" ? loginRes.data : JSON.stringify(loginRes.data ?? {});
                            
                            if (loginTxt.includes("实验") && !loginTxt.includes("login")) {
                                debug("[loginExperiment] ✓ 重定向页登录成功");
                                return true;
                            }
                        } catch (e) {
                            debug(`[loginExperiment] 重定向页登录失败: ${String(e)}`);
                        }
                    }
                }
            }
        } catch (e) {
            debug(`[loginExperiment] 访问重定向URL失败: ${String(e)}`);
        }
    }

    // Step 4: Try direct access to experiment URL
    debug("[loginExperiment] 步骤4: 尝试直接访问实验课页面...");
    const expPage = await ctx.http.get(EXPERIMENT_COURSE_API, { timeout: 15000, withCredentials: true });
    const expTxt = typeof expPage.data === "string" ? expPage.data : JSON.stringify(expPage.data ?? {});
    debug(`[loginExperiment] 直接访问长度: ${expTxt.length}`);

    if (expTxt.includes("实验") && !expTxt.includes("login")) {
        debug("[loginExperiment] ✓ 直接访问成功");
        return true;
    }

    // Step 5: Try alternative experiment URLs
    debug("[loginExperiment] 步骤5: 尝试其他实验课URL...");
    const altUrls = [
        "https://sjjx.dean.swust.edu.cn/teachn/teachnAction/selCourse.action",
    ];
    
    for (const url of altUrls) {
        debug(`[loginExperiment] 尝试: ${url}`);
        try {
            const altRes = await ctx.http.get(url, { timeout: 15000, withCredentials: true });
            const altTxt = typeof altRes.data === "string" ? altRes.data : JSON.stringify(altRes.data ?? {});
            debug(`[loginExperiment] 响应长度: ${altTxt.length}`);
            
            if (altTxt.includes("实验") && !altTxt.includes("login")) {
                debug(`[loginExperiment] ✓ 通过 ${url} 访问成功`);
                return true;
            }
        } catch (e) {
            debug(`[loginExperiment] 访问 ${url} 失败: ${String(e)}`);
        }
    }

    debug("[loginExperiment] ✗ 无法访问实验课系统");
    return false;
}

// Fetch and parse experiment course table
async function fetchExperimentCourses(ctx, debug) {
    debug("[fetchExperimentCourses] 开始获取实验课课表");
    const allEvents = [];
    let pageNum = 1;
    let totalPages = 1;

    do {
        debug(`[fetchExperimentCourses] 获取第 ${pageNum} 页...`);
        try {
            // Use the correct experiment course API endpoint
            const url = `${EXPERIMENT_COURSE_API}?page.pageNum=${pageNum}`;
            const res = await ctx.http.get(url, { timeout: 15000, withCredentials: true });
            const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});

            // Parse total pages from #myPage element
            if (pageNum === 1) {
                // Pattern: "第 1 页 / 共 5 页" or "第1页/共5页"
                const pageMatch = html.match(/第\s*(\d+)\s*页\s*\/\s*共\s*(\d+)\s*页/);
                if (pageMatch) {
                    totalPages = Number(pageMatch[2]);
                    debug(`[fetchExperimentCourses] 共 ${totalPages} 页`);
                } else {
                    // Alternative: try #myPage > p parsing
                    const myPageMatch = html.match(/id=["']myPage["'][^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
                    if (myPageMatch) {
                        const pageText = myPageMatch[1].replace(/页/g, "").replace(/ /g, "").replace(/第/g, "").replace(/共/g, "");
                        const parts = pageText.split("/");
                        if (parts.length === 2) {
                            totalPages = Number(parts[1]) || 1;
                            debug(`[fetchExperimentCourses] 共 ${totalPages} 页 (alternative parse)`);
                        }
                    }
                }
            }

            // Parse course rows using tabson class
            // HTML structure: <div class="tabson"><table><tbody><tr><td>...</td></tr></tbody></table></div>
            let rowCount = 0;
            
            // Match all tr elements within the table
            const trMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
            for (const trMatch of trMatches) {
                const trHtml = trMatch[1];
                const tdMatches = trHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
                const cells = [];
                for (const tdMatch of tdMatches) {
                    cells.push(stripTags(tdMatch[1]).trim());
                }

                // Need at least 5 columns: courseName, projectName, time, location, teacher
                if (cells.length >= 5) {
                    const courseName = cells[0];
                    const projectName = cells[1];
                    const timeStr = cells[2];
                    const location = cells[3];
                    const teacher = cells[4];

                    if (!courseName || !timeStr) continue;

                    const timeInfo = parseExperimentTime(timeStr, debug);
                    if (timeInfo) {
                        const eventId = `exp-${timeInfo.week}-${timeInfo.day}-${timeInfo.startSection}-${Date.now()}`.replace(/\s+/g, "-");
                        allEvents.push({
                            id: eventId,
                            title: courseName,
                            day: timeInfo.day,
                            start: timeInfo.startTime,
                            end: timeInfo.endTime,
                            location: location || undefined,
                            teacher: teacher || undefined,
                            weeks: [timeInfo.week],
                        });
                        rowCount++;
                    }
                }
            }
            debug(`[fetchExperimentCourses] 第 ${pageNum} 页解析 ${rowCount} 个实验课`);
            pageNum++;
        } catch (e) {
            debug(`[fetchExperimentCourses] ✗ 获取失败: ${String(e)}`);
            break;
        }
    } while (pageNum <= totalPages && pageNum <= 20);

    debug(`[fetchExperimentCourses] 共获取 ${allEvents.length} 个实验课`);
    return allEvents;
}

async function fetchTimetable(ctx, debug) {
    debug("[fetchTimetable] 开始获取课表");
    const urls = [TIMETABLE_URL];
    const rawSnapshots = [];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        debug(`[fetchTimetable] 尝试 ${i + 1}/${urls.length}: ${url}`);
        try {
            const res = await ctx.http.get(url, { timeout: 15000, withCredentials: true });
            debug(`[fetchTimetable] 状态: ${res.status}`);
            const rawText = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});
            debug(`[fetchTimetable] 长度: ${rawText.length}`);
            rawSnapshots.push({ url, length: rawText.length, html: rawText });

            debug("[fetchTimetable] 解析课程...");
            const events = parseCourses(res.data, ctx, debug);
            debug(`[fetchTimetable] 解析到 ${events.length} 个课程`);

            if (events.length > 0) {
                const startDates = extractTermStartDates(rawText);
                debug(`[fetchTimetable] 学期开始日期: ${startDates.join(", ")}`);

                // Also fetch experiment courses
                debug("[fetchTimetable] 获取实验课课表...");
                const expEvents = await fetchExperimentCourses(ctx, debug);
                const allEvents = [...events, ...expEvents];
                debug(`[fetchTimetable] 总计 ${allEvents.length} 个课程 (实验课: ${expEvents.length})`);

                debug("[fetchTimetable] ✓ 获取课表成功");
                return {
                    events: allEvents,
                    debug: { rawHtml: rawSnapshots },
                    configurations: {
                        "start-time": startDates,
                        "script-name": "西南科技大学",
                    },
                };
            }
        } catch (e) {
            debug(`[fetchTimetable] ✗ 请求失败: ${String(e)}`);
        }
    }
    debug("[fetchTimetable] ✗ 未获取到任何课程");
    return { events: [], debug: { rawHtml: rawSnapshots } };
}

function parseExperimentCourses(html, debug) {
    debug("[parseExperimentCourses] 开始解析实验课表");
    const events = [];
    const txt = String(html ?? "");

    // Save raw HTML snippet for debugging (first 2000 chars)
    debug(`[parseExperimentCourses] HTML长度: ${txt.length}`);
    debug(`[parseExperimentCourses] HTML预览: ${txt.substring(0, 500)}...`);

    if (!txt.includes("实验") && !txt.includes("实验室")) {
        debug("[parseExperimentCourses] 未检测到实验课表特征");
        return events;
    }
    debug("[parseExperimentCourses] ✓ 检测到实验课表特征");
    
    // Try to parse experiment course table
    // Common format: table with columns like [周次, 星期, 节次, 实验名称, 实验室, 教师]
    const trList = txt.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    debug(`[parseExperimentCourses] 找到 ${trList.length} 个 <tr>`);
    
    for (let i = 0; i < trList.length; i++) {
        const tr = trList[i];
        const tdList = tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (tdList.length < 3) continue;
        
        // Extract text content from each TD
        const cells = tdList.map(td => stripTags(td).trim());
        
        // Try to identify row structure
        // Pattern 1: [周次, 星期, 节次, 课程名, 教室, 教师]
        // Pattern 2: [实验项目, 周次, 时间, 地点, 指导教师]
        // Pattern 3: Nested table with course info
        
        let weekInfo = null;
        let dayInfo = null;
        let sectionInfo = null;
        let courseName = null;
        let location = null;
        let teacher = null;
        
        for (let j = 0; j < cells.length; j++) {
            const cell = cells[j];
            if (!cell) continue;
            
            // Check for week info (第X周 or X-Y周)
            if (!weekInfo && /第?\d{1,2}[-~至]?\d{0,2}周/.test(cell)) {
                weekInfo = parseExperimentWeeks(cell);
                continue;
            }
            
            // Check for day info (周X or 星期X)
            if (!dayInfo) {
                for (const [key, value] of Object.entries(DAY_CN_MAP)) {
                    if (cell.includes(key)) {
                        dayInfo = value;
                        break;
                    }
                }
                if (dayInfo) continue;
            }
            
            // Check for section info (第X节)
            if (!sectionInfo && /第?\d{1,2}[-~至]?\d{0,2}节/.test(cell)) {
                sectionInfo = parseSectionTime(cell);
                continue;
            }
            
            // Check for time format (HH:MM-HH:MM)
            if (!sectionInfo && /\d{1,2}:\d{2}\s*[-~至]\s*\d{1,2}:\d{2}/.test(cell)) {
                const timeMatch = cell.match(/(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})/);
                if (timeMatch) {
                    sectionInfo = { startTime: timeMatch[1], endTime: timeMatch[2] };
                }
                continue;
            }
            
            // Check for lab/location keywords
            if (!location && /实验室|实验中心|机房|实训室|Lab|Labo/i.test(cell)) {
                location = cell;
                continue;
            }
            
            // Check for course name (contains 实验 or is substantial text)
            if (!courseName && cell.length > 2) {
                if (/实验|实训|上机|实践/.test(cell)) {
                    courseName = cell;
                    continue;
                }
                // If no experiment keyword found yet, consider longer text as course name
                if (j > 2 && !courseName && cell.length > 4 && !/\d{4}-\d{2}-\d{2}/.test(cell)) {
                    courseName = cell;
                }
            }
            
            // Check for teacher (usually contains only names)
            if (!teacher && cell.length >= 2 && cell.length <= 10 && /^[\u4e00-\u9fa5]+$/.test(cell)) {
                if (cell !== dayInfo && !/周|星期/.test(cell)) {
                    teacher = cell;
                }
            }
        }
        
        // Skip rows without essential info
        if (!courseName && !location) continue;
        if (!weekInfo && !sectionInfo) continue;
        
        // Build event
        const section = sectionInfo || { start: 1, end: 2 };
        const time = section.startTime 
            ? { start: section.startTime, end: section.endTime }
            : {
                start: SECTION_TIME_MAP[section.start] || "08:00",
                end: SECTION_TIME_MAP[section.end] || "09:40"
            };
        
        events.push({
            id: `exp-${i}-${Date.now()}`,
            title: courseName || "实验课",
            day: dayInfo || "Mon",
            start: time.start,
            end: time.end,
            location: location || undefined,
            teacher: teacher || undefined,
            weeks: weekInfo,
        });
        
        if (events.length <= 5) {
            debug(`[parseExperimentCourses] 解析课程: ${courseName || "实验课"}, 周${dayInfo || "?"}, ${time.start}-${time.end}`);
        }
    }
    
    // Alternative parsing: look for specific experiment table format
    // Some schools use a different table structure
    if (events.length === 0) {
        debug("[parseExperimentCourses] 尝试备选解析方式");
        
        // Look for course entries with specific patterns
        const coursePattern = /实验[名称]?[：:]\s*([^\n<]+)/gi;
        let match;
        while ((match = coursePattern.exec(txt)) !== null) {
            debug(`[parseExperimentCourses] 发现实验课程: ${match[1]}`);
        }
    }
    
    debug(`[parseExperimentCourses] 共解析 ${events.length} 个实验课程`);
    return events;
}

function parseCourses(raw, ctx, debug) {
    debug("[parseCourses] 开始解析");

    // Check for experiment course table first
    if (typeof raw === "string") {
        const expEvents = parseExperimentCourses(raw, debug);
        if (expEvents.length > 0) {
            debug(`[parseCourses] 实验课表解析成功: ${expEvents.length} 个课程`);
            return expEvents;
        }
    }
    
    // HTML parsing
    if (typeof raw === "string" && raw.includes("course")) {
        debug("[parseCourses] 检测到HTML格式");
        const events = [];
        const trList = raw.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        debug(`[parseCourses] 找到 ${trList.length} 个 <tr>`);
        const dayMap = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

        // Debug: log first few tr structures to understand the format
        let loggedTrCount = 0;
        for (const tr of trList) {
            const tdList = tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
            
            // Debug: log actual TD content for first 5 TRs
            if (loggedTrCount < 5 && tdList.length > 0) {
                debug(`[parseCourses] TR#${loggedTrCount}: ${tdList.length}个TD`);
                debug(`[parseCourses] TD[0]: ${stripTags(tdList[0]).slice(0, 50)}`);
                if (tdList[1]) debug(`[parseCourses] TD[1]: ${tdList[1].slice(0, 200)}`);
                loggedTrCount++;
            }

            // Try to parse lecture number from any TD
            let lectureIdx = null;
            for (const td of tdList) {
                const num = parseLectureNumber(td);
                if (num !== null) {
                    lectureIdx = num;
                    break;
                }
            }
            if (!lectureIdx) continue;

            const time = LECTURE_TIME_MAP[lectureIdx] ?? { start: "08:00", end: "09:40" };

            // Detect row structure: 
            // - 9 TDs: [时间段标记, 第一讲, 周一, 周二, 周三, 周四, 周五, 周六, 周日]
            // - 8 TDs: [第二讲, 周一, 周二, 周三, 周四, 周五, 周六, 周日]
            const hasTimeMarker = /上午|下午|晚上/.test(stripTags(tdList[0]));
            const dayOffset = hasTimeMarker ? 2 : 1;  // Course columns start at index 2 or 1
            
            // Look for course content in all TDs
            for (let col = 0; col < tdList.length; col++) {
                const td = tdList[col];
                const tdText = stripTags(td);
                
                // Skip if TD is mostly empty or just a lecture marker
                if (tdText.length < 5 || parseLectureNumber(td) !== null) continue;
                
                // Skip time marker columns (上午/下午/晚上)
                if (hasTimeMarker && col === 0) continue;
                
                // Look for course-like content: multiple lines or specific patterns
                if (tdText.includes("\n") || /[\u4e00-\u9fa5]{2,}/.test(tdText)) {
                    // Log TDs that might contain courses
                    if (loggedTrCount < 10) {
                        debug(`[parseCourses] 发现可能课程的TD: ${tdText.slice(0, 100)}`);
                    }
                    
                    // Extract course info from the text
                    // Format: Line 1: "课程名[编号] - 教师", Line 2: "周次", Line 3: "教室"
                    const lines = tdText.split(/\s*\n\s*/).filter(l => l.trim());
                    if (lines.length >= 1) {
                        const firstLine = lines[0].trim();
                        
                        // Parse course name and teacher from "课程名[编号] - 教师"
                        let courseName = firstLine;
                        let teacher = undefined;
                        const teacherMatch = firstLine.match(/^(.+?)\s*[-–—]\s*(.+)$/);
                        if (teacherMatch) {
                            courseName = teacherMatch[1].trim();
                            teacher = teacherMatch[2].trim();
                        }
                        
                        // Determine day from column position
                        const dayCol = col - dayOffset;
                        
                        events.push({
                            id: `swust-${lectureIdx}-${col}`,
                            title: courseName,
                            day: dayMap[dayCol] ?? "Mon",
                            start: time.start,
                            end: time.end,
                            location: lines[2]?.trim() || undefined,  // Line 3 is location
                            teacher: teacher,
                            weeks: lines[1] ? parseWeeks(lines[1]) : undefined,  // Line 2 is weeks
                        });
                    }
                }
            }
        }
        if (events.length > 0) {
            debug(`[parseCourses] HTML解析成功: ${events.length} 个课程`);
            return events;
        }
    }

    // JSON parsing
    debug("[parseCourses] 尝试JSON解析");
    const lists = [];
    if (Array.isArray(raw)) lists.push(raw);
    if (Array.isArray(raw?.data)) lists.push(raw.data);
    if (Array.isArray(raw?.courses)) lists.push(raw.courses);
    debug(`[parseCourses] 找到 ${lists.length} 个可能的列表`);

    for (const list of lists) {
        const events = list.filter(x => x && typeof x === "object").map((item, i) => {
            const title = item.title ?? item.name ?? item.courseName ?? item.kcmc;
            if (!title) return null;
            return {
                id: String(item.id ?? item.jxbid ?? `swust-${i}`),
                title: String(title),
                day: normalizeDay(item.day ?? item.weekDay ?? item.xqj),
                start: SECTION_TIME_MAP[item.ksjc] ?? item.start ?? "08:00",
                end: SECTION_TIME_MAP[item.jsjc] ?? item.end ?? "09:40",
                location: item.jsmc ?? item.cdmc ?? "",
                teacher: item.jsxm ?? item.skjs ?? "",
            };
        }).filter(Boolean);
        if (events.length > 0) {
            debug(`[parseCourses] JSON解析成功: ${events.length} 个课程`);
            return events;
        }
    }

    debug("[parseCourses] ✗ 未能解析任何课程");
    return [];
}

exports.run = async (ctx) => {
    const { phone, smsCode } = ctx.config;
    const debugLog = [];
    const debug = (msg) => {
        const line = `[${new Date().toISOString().split('T')[1]}] ${msg}`;
        debugLog.push(line);
        ctx.log(msg);
    };

    debug("========================================");
    debug("SWUST Plugin Start " + ctx.now());
    debug("========================================");1
    debug(`[run] 手机号: ${phone}`);
    debug(`[run] 验证码: ${smsCode ? "***已填写***" : "(空)"}`);
    debug(`[run] HTTP后端: ${ctx.httpBackend}`);

    // Validate input
    if (!phone || !/^\d{11}$/.test(phone)) {
        debug("[run] ✗ 手机号格式无效");
        return { events: [], debug: { log: debugLog, error: "请输入有效的手机号 (11位数字)" } };
    }

    // Send SMS code
    if (ctx.hasButton("Get_Sms_Code")) {
        debug("[run] >>> 发送验证码模式 <<<");
        const sent = await sendSmsCode(ctx, phone, debug);
        if (!sent) {
            debug("[run] ✗ 发送验证码失败");
            return { events: [], debug: { log: debugLog, error: "发送验证码失败" } };
        }
        await ctx.storage.set("swust_force_login", true);
        debug("[run] ✓ 验证码已发送");
        return { events: [], debug: { log: debugLog, smsSent: true } };
    }

    // Login and fetch timetable
    if (ctx.hasButton("login")) {
        debug("[run] >>> 登录获取课表模式 <<<");

        if (!smsCode || !/^\d{4,8}$/.test(smsCode)) {
            debug("[run] ✗ 验证码格式无效");
            return { events: [], debug: { log: debugLog, error: "请输入验证码 (4-8位数字)" } };
        }

        // Store credentials for experiment system login
        await ctx.storage.set("swust_phone", phone);
        await ctx.storage.set("swust_sms_code", smsCode);

        const forceLogin = await ctx.storage.get("swust_force_login");
        debug(`[run] 强制登录标记: ${forceLogin}`);

        if (forceLogin) {
            await ctx.storage.remove("swust_force_login");
            debug("[run] 强制重新登录，跳过会话检查");
        } else {
            debug("[run] 检查现有会话...");
            const hasSession = await verifySession(ctx, debug);
            if (hasSession) {
                debug("[run] ✓ 使用现有会话");
                // Try to login experiment system
                await loginExperiment(ctx, debug);
                const result = await fetchTimetable(ctx, debug);
                return { ...result, debug: { ...result.debug, log: debugLog, sessionReused: true } };
            }
            debug("[run] 会话无效，需要重新登录");
        }

        debug("[run] 开始登录流程...");
        const loggedIn = await login(ctx, phone, smsCode, debug);
        if (!loggedIn) {
            debug("[run] ✗ 登录失败");
            return { events: [], debug: { log: debugLog, error: "登录失败" } };
        }

        debug("[run] 验证登录后的会话...");
        const sessionValid = await verifySession(ctx, debug);
        if (!sessionValid) {
            ctx.warn("[run] ⚠ 会话验证失败，但继续尝试获取课表");
        }

        // Try to login experiment system
        debug("[run] 尝试登录实验课系统...");
        await loginExperiment(ctx, debug);

        debug("[run] >>> 开始获取课表 <<<");
        const result = await fetchTimetable(ctx, debug);
        debug(`[run] ✓ 完成，获取 ${result.events.length} 个课程`);
        return { ...result, debug: { ...result.debug, log: debugLog, loginSuccess: true } };
    }

    debug("[run] ✗ 未点击任何按钮");
    return { events: [], debug: { log: debugLog, error: "请点击按钮执行操作" } };
};
