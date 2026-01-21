"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const https = __importStar(require("https"));
const http = __importStar(require("http"));
// --- Utils: HTTP GET ---
async function getRequest(url, headers) {
    const client = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
        const req = client.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', (e) => reject(e));
    });
}
// --- Utils: Diff Line Numbers ---
function addLineNumbersToDiff(diff) {
    const lines = diff.split('\n');
    let result = [];
    let currentNewLine = null;
    for (let line of lines) {
        if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)/);
            if (match) {
                currentNewLine = parseInt(match[1]);
            }
            result.push(line);
            continue;
        }
        if (line.startsWith('---') || line.startsWith('+++')) {
            result.push(line);
            continue;
        }
        if (line.startsWith('+')) {
            result.push(`Line ${currentNewLine}: ${line}`);
            if (currentNewLine !== null)
                currentNewLine++;
        }
        else if (line.startsWith(' ')) {
            result.push(`Line ${currentNewLine}: ${line}`);
            if (currentNewLine !== null)
                currentNewLine++;
        }
        else if (line.startsWith('-')) {
            result.push(`OLD: ${line}`);
        }
        else {
            result.push(line);
        }
    }
    return result.join('\n');
}
// --- Inputs ---
let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false";
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese";
const include_files = (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || "");
const event_action = process.env.INPUT_EVENT_ACTION || "";
const event_before = process.env.INPUT_EVENT_BEFORE || "";
const force_full_review = (process.env.INPUT_REVIEW_PULL_REQUEST || "false").toLowerCase() === "true";
function system_prompt_numbered(language) {
    return `
You are a pragmatic Senior Technical Lead. Review the provided git diffs focusing on logic, security, performance, and maintainability.

**INPUT CONTEXT:**
The code is pre-processed with line numbers (e.g., "Line 12: + const a = 1;").

**REVIEW GUIDELINES:**
1. **Filter Noise:** Ignore minor formatting/style issues (Prettier/ESLint) unless they affect logic.
2. **Threshold:** Only report issues with **Score >= 2**. Ignore trivial nitpicks.
3. **Context:** The "Context" field must be an EXACT COPY of the source line including the "Line X:" prefix.
4. **Language:** Write the *content* of the comments in ${language}.

**SCORING LEGEND:**
- [Score: 5] Critical (Security hole, crash, data loss).
- [Score: 4] Major (Logic error, performance bottleneck).
- [Score: 3] Moderate (Bad practice, maintainability).
- [Score: 2] Minor (Optimization suggestion).

**LGTM LOGIC (Crucial):**
- If the code looks good and **NO issues with Score >= 2** are found, output the Summary followed strictly by the text "**LGTM**".
- Do NOT output any "File/Context/Comment" blocks in this case.

**OUTPUT FORMAT:**

<Brief Summary of changes in ${language}>

<If issues exist:>
---
File: <file_path>
Context: <EXACT COPY from diff>
StartLine: <number>
EndLine: <number>
Comment: [Score: 2-5] <Concise comment in ${language}>
---

<If NO issues exist:>
LGTM
`;
}
const system_prompt = reviewers_prompt || system_prompt_numbered(language);
const url = process.env.INPUT_HOST;
if (!url) {
    console.error('HOST input is required.');
    process.exit(1);
}
const model = process.env.INPUT_MODEL;
if (!model) {
    console.error('model input is required.');
    process.exit(1);
}
// --- API Logic ---
async function getLastReviewedCommitId() {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER)
        return null;
    let baseUrl = process.env.GITHUB_API_URL || "";
    if (baseUrl.endsWith("/"))
        baseUrl = baseUrl.slice(0, -1);
    const apiUrl = `${baseUrl}/repos/${process.env.INPUT_REPOSITORY}/pulls/${process.env.INPUT_PULL_REQUEST_NUMBER}/reviews`;
    try {
        const reviews = await getRequest(apiUrl, {
            'Authorization': `token ${process.env.INPUT_TOKEN}`,
            'User-Agent': 'AiReviewPR'
        });
        if (!Array.isArray(reviews) || reviews.length === 0)
            return null;
        const sortedReviews = reviews.sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
        const lastReview = sortedReviews[0];
        if (lastReview && lastReview.commit_id) {
            return lastReview.commit_id;
        }
    }
    catch (e) {
        console.warn("[WARN] Failed to fetch reviews:", e);
    }
    return null;
}
async function submitPullRequestReview(message, event, comments, commit_id) {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER)
        return { id: 0 };
    const body = { body: message, event: event, commit_id: commit_id, comments: [] };
    if (comments.length > 0) {
        // @ts-ignore
        body.comments = comments.map(c => ({
            path: c.path,
            new_position: c.line,
            body: (c.start_line && c.start_line !== c.line) ? `[Lines ${c.start_line}-${c.line}] ${c.body}` : c.body
        }));
    }
    return await (0, utils_1.post)({
        url: `${process.env.GITHUB_API_URL}/repos/${process.env.INPUT_REPOSITORY}/pulls/${process.env.INPUT_PULL_REQUEST_NUMBER}/reviews`,
        body: body,
        header: { 'Authorization': `token ${process.env.INPUT_TOKEN}` }
    });
}
async function aiGenerate({ host, token, prompt, model, system }) {
    let endpoint = host;
    if (!endpoint.endsWith("/"))
        endpoint += "/";
    if (!endpoint.includes("/v1/"))
        endpoint += "v1/";
    endpoint += "chat/completions";
    return await (0, utils_1.post)({
        url: endpoint,
        body: JSON.stringify({
            model,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
            temperature: 0.7
        }),
        header: (token && token.trim() !== "") ? { 'Authorization': `Bearer ${token}` } : {}
    });
}
// --- Improved Git Logic ---
// 尝试拉取对象
function fetchTarget(target, depth = 1) {
    try {
        // 显式打印命令，方便调试
        console.log(`[GIT] Fetching ${target} with depth ${depth}...`);
        (0, node_child_process_1.execSync)(`git fetch origin ${target} --depth=${depth}`, { stdio: 'inherit' }); // 使用 inherit 查看 git 原生报错
        return true;
    }
    catch (e) {
        console.warn(`[WARN] Fetch failed for ${target}. The server might deny fetching specific SHAs.`);
        return false;
    }
}
// 严格检查 Commit 是否存在 (使用 git cat-file -e)
function commitExists(sha) {
    try {
        (0, node_child_process_1.execSync)(`git cat-file -e "${sha}^{commit}"`, { stdio: 'ignore' });
        return true;
    }
    catch (e) {
        return false;
    }
}
// 获取文件差异列表
function getChangedFiles(start, end) {
    try {
        const output = (0, node_child_process_1.execSync)(`git diff --name-only "${start}" "${end}"`, { encoding: 'utf-8' });
        return output.trim().split("\n").filter(f => f);
    }
    catch (e) {
        throw new Error(`Git diff --name-only failed between ${start} and ${end}`);
    }
}
// 获取文件具体内容差异
function getFileDiff(start, end, file) {
    return (0, node_child_process_1.execSync)(`git diff "${start}" "${end}" -- "${file}"`, { encoding: 'utf-8' });
}
// --- Core Logic with Fallback ---
async function getDiffItems() {
    const BASE_REF = process.env.INPUT_BASE_REF || "";
    let startPoint = "";
    const endPoint = "HEAD";
    let isIncremental = false;
    console.log(`[INFO] Event: '${event_action}', ForceFull: ${force_full_review}`);
    // 1. Determine Start Point
    const isSyncEvent = event_action.includes("sync"); // synchronized or synchronize
    if (!force_full_review && isSyncEvent) {
        if (event_before && event_before !== "null" && event_before.trim() !== "") {
            startPoint = event_before;
            isIncremental = true;
            console.log(`[INFO] Strategy: Payload Before (${startPoint})`);
        }
        else {
            console.log(`[INFO] Strategy: Querying API for last reviewed commit...`);
            const lastReviewedSha = await getLastReviewedCommitId();
            if (lastReviewedSha) {
                startPoint = lastReviewedSha;
                isIncremental = true;
                console.log(`[INFO] Found previous review: ${startPoint}`);
            }
        }
    }
    // 2. Prepare Local Data (Fetch if needed)
    if (isIncremental && startPoint) {
        if (!commitExists(startPoint)) {
            console.log(`[INFO] Start point ${startPoint} missing. Attempting fetch...`);
            fetchTarget(startPoint);
        }
        if (!commitExists(startPoint)) {
            console.warn(`[WARN] Start point ${startPoint} unreachable. Fallback to Full Review.`);
            isIncremental = false;
        }
    }
    if (!isIncremental) {
        startPoint = `origin/${BASE_REF}`;
        console.log(`[INFO] Mode: Full Review (Base: ${startPoint})`);
        fetchTarget(BASE_REF);
    }
    // 3. Execute Diff with Safe Fallback
    let items = [];
    try {
        console.log(`[INFO] Executing Diff: ${startPoint} ... ${endPoint}`);
        const files = getChangedFiles(startPoint, endPoint); // 这一步可能会抛错
        for (const filePath of files) {
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, filePath)))
                continue;
            if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, filePath)))
                continue;
            const diffContext = getFileDiff(startPoint, endPoint, filePath);
            const numberedDiff = addLineNumbersToDiff(diffContext);
            if (numberedDiff.trim().length > 0) {
                items.push({ path: filePath, context: numberedDiff });
            }
        }
    }
    catch (error) {
        console.error(`[ERROR] Diff failed: ${error.message}`);
        // --- 终极保底重试逻辑 ---
        if (isIncremental) {
            console.warn(`[WARN] Incremental diff failed. Switching to Full Review and retrying...`);
            // 强制全量
            startPoint = `origin/${BASE_REF}`;
            fetchTarget(BASE_REF);
            try {
                console.log(`[INFO] Retrying Diff: ${startPoint} ... ${endPoint}`);
                const files = getChangedFiles(startPoint, endPoint);
                for (const filePath of files) {
                    if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, filePath)))
                        continue;
                    if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, filePath)))
                        continue;
                    const diffContext = getFileDiff(startPoint, endPoint, filePath);
                    const numberedDiff = addLineNumbersToDiff(diffContext);
                    if (numberedDiff.trim().length > 0) {
                        items.push({ path: filePath, context: numberedDiff });
                    }
                }
                isIncremental = false; // 标记为全量
            }
            catch (retryError) {
                console.error(`[FATAL] Full review retry also failed.`, retryError);
                return { items: [], isIncremental: false };
            }
        }
    }
    return { items, isIncremental };
}
// --- Main ---
async function aiCheckDiffContext() {
    try {
        const { items, isIncremental } = await getDiffItems();
        if (items.length === 0) {
            console.log("No changes detected. LGTM.");
            return;
        }
        let allComments = [];
        let fileSummaries = [];
        for (const item of items) {
            console.log(`[DEBUG] Reviewing: ${item.path}`);
            try {
                let response = await aiGenerate({
                    host: url, token: process.env.INPUT_AI_TOKEN, prompt: item.context, model: model, system: system_prompt
                });
                if (!response.choices || response.choices.length === 0)
                    continue;
                let content = response.choices[0].message.content.trim();
                const match = content.match(/^```(markdown)?\s*([\s\S]*?)\s*```$/i);
                if (match)
                    content = match[2].trim();
                const parsed = (0, utils_1.parseAIReviewResponse)(content);
                if (parsed.comments.length > 0)
                    allComments.push(...parsed.comments);
                if (parsed.body)
                    fileSummaries.push({ path: item.path, summary: parsed.body });
            }
            catch (e) {
                console.error(`[ERROR] AI check failed for ${item.path}:`, e);
            }
        }
        if (allComments.length > 0 || fileSummaries.length > 0) {
            let Review = useChinese ? "审核结果" : "Review";
            const modeLabel = isIncremental ? "(Incremental/增量)" : "(Full/全量)";
            let body = `# ${Review} Summary ${modeLabel}\n\n`;
            if (fileSummaries.length > 0) {
                body += fileSummaries.map(s => `* **${s.path}**: ${s.summary.replace(/\n/g, ' ')}`).join('\n');
            }
            let event = (allComments.length === 0 && body.includes("LGTM")) ? 'APPROVE' : 'COMMENT';
            if (allComments.length > 0)
                event = 'COMMENT';
            console.log(`[INFO] Submitting ${allComments.length} comments.`);
            let resp = await submitPullRequestReview(body, event, allComments, process.env.GITHUB_SHA);
            console.log("Submit success:", resp.id);
        }
        else {
            console.log("LGTM (No issues found).");
        }
    }
    catch (error) {
        console.error('Execution Error:', error);
        process.exit(1);
    }
}
aiCheckDiffContext()
    .then(_ => console.log(useChinese ? "检查结束" : "review finish"))
    .catch(e => {
    console.error(useChinese ? "检查失败:" : "review error", e);
    process.exit(1);
});
