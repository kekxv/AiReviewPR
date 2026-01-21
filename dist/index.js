"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils"); // 确保 utils 里导出了 get 方法
// --- 辅助函数：给 Diff 增加行号  ---
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
// --- 读取配置 ---
let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false";
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese";
const include_files = (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || "");
// 读取事件信息
const event_action = process.env.INPUT_EVENT_ACTION || "";
const event_before = process.env.INPUT_EVENT_BEFORE || "";
// 强制全量审查开关
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
/**
 * 获取该 PR 上一次被审查的 Commit ID
 */
async function getLastReviewedCommitId() {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER)
        return null;
    console.log("[INFO] Trying to fetch previous reviews to determine start point...");
    try {
        // 构造 URL，注意处理末尾斜杠
        let baseUrl = process.env.GITHUB_API_URL || "";
        if (baseUrl.endsWith("/"))
            baseUrl = baseUrl.slice(0, -1);
        const apiUrl = `${baseUrl}/repos/${process.env.INPUT_REPOSITORY}/pulls/${process.env.INPUT_PULL_REQUEST_NUMBER}/reviews`;
        console.log(`[DEBUG] Fetching reviews from: ${apiUrl}`);
        const headers = {
            'Authorization': `token ${process.env.INPUT_TOKEN}`,
            'User-Agent': 'AiReviewPR-Action'
        };
        // 如果 utils 里有 get 就用 get，没有就用 getRequest
        // const reviews = await get({ url: apiUrl, headers: headers });
        const reviews = await (0, utils_1.get)(apiUrl, headers);
        if (!Array.isArray(reviews) || reviews.length === 0) {
            console.log("[INFO] No previous reviews found.");
            return null;
        }
        // 找到最后一次由机器人或当前 Token 用户提交的 Review
        // 通常 Gitea Actions 使用的 Token 用户名是 "gitea-actions" 或者 bot
        // 这里我们简单起见，取时间最近的一次 review (不管是谁review的，这代表代码被看过)
        // 或者你可以过滤: const myReviews = reviews.filter(r => r.user.login === 'gitea-actions');
        // 倒序排列，取最新的
        const sortedReviews = reviews.sort((a, b) => {
            return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime();
        });
        const lastReview = sortedReviews[0];
        if (lastReview && lastReview.commit_id) {
            console.log(`[INFO] Found last review on commit: ${lastReview.commit_id} (at ${lastReview.submitted_at})`);
            return lastReview.commit_id;
        }
    }
    catch (e) {
        console.warn("[WARN] Failed to fetch previous reviews via API:", e);
    }
    return null;
}
async function submitPullRequestReview(message, event, comments = [], commit_id) {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
        console.log(message);
        return { id: 0 };
    }
    const body = {
        body: message,
        event: event,
        commit_id: commit_id
    };
    if (comments.length > 0) {
        body.comments = comments.map(comment => {
            let commentBody = comment.body;
            if (comment.start_line && comment.start_line !== comment.line) {
                commentBody = `[Lines ${comment.start_line}-${comment.line}] ${commentBody}`;
            }
            return {
                path: comment.path,
                new_position: comment.line,
                body: commentBody
            };
        });
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
    const data = JSON.stringify({
        model: model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
        ],
        temperature: 0.7,
        top_p: 1,
    });
    const headers = {};
    if (token && token.trim() !== "")
        headers['Authorization'] = `Bearer ${token}`;
    return await (0, utils_1.post)({ url: endpoint, body: data, header: headers });
}
// --- Git 操作核心逻辑 ---
function fetchTarget(target, depth = 1) {
    try {
        (0, node_child_process_1.execSync)(`git fetch origin ${target} --depth=${depth}`, { stdio: 'ignore' });
        return true;
    }
    catch (e) {
        console.warn(`[WARN] Failed to shallow fetch ${target}.`);
        return false;
    }
}
function commitExists(sha) {
    try {
        (0, node_child_process_1.execSync)(`git rev-parse --verify "${sha}"`, { stdio: 'ignore' });
        return true;
    }
    catch (e) {
        return false;
    }
}
/**
 * 智能获取 Diff 上下文
 */
async function getSmartDiffContext() {
    let items = [];
    const BASE_REF = process.env.INPUT_BASE_REF || "";
    let startPoint = "";
    let endPoint = "HEAD";
    let isIncremental = false;
    console.log(`[INFO] Event: '${event_action}', ForceFull: ${force_full_review}, Before from Payload: '${event_before}'`);
    // 辅助判断：是否为同步事件 (兼容 synchronized 和 synchronize)
    const isSyncEvent = event_action.includes("sync");
    // 1. 优先使用 Payload 中的 Before
    if (!force_full_review && isSyncEvent && event_before && event_before !== "null" && event_before.trim() !== "") {
        startPoint = event_before;
        isIncremental = true;
        console.log(`[INFO] Strategy: Standard Payload (Before: ${startPoint}).`);
    }
    // 2. Payload 缺失，尝试通过 API 查找上次 Review 的记录 (Gitea Fallback 终极方案)
    else if (!force_full_review && isSyncEvent) {
        console.log(`[INFO] Strategy: 'Before' missing in ${event_action}. Querying API for last reviewed commit...`);
        const lastReviewedSha = await getLastReviewedCommitId();
        if (lastReviewedSha) {
            startPoint = lastReviewedSha;
            isIncremental = true;
            console.log(`[INFO] Found previous review at ${startPoint}. Doing Incremental Review from there.`);
        }
        else {
            console.log(`[INFO] No previous review found via API (First time review?). Must do Full Review.`);
        }
    }
    // 3. 执行逻辑
    if (isIncremental && startPoint) {
        // 尝试拉取 startPoint (以防本地只有 shallow clone)
        if (!commitExists(startPoint)) {
            console.log(`[INFO] Fetching start point ${startPoint}...`);
            fetchTarget(startPoint);
        }
        // 再次确认是否存在
        if (!commitExists(startPoint)) {
            console.warn(`[WARN] Incremental start point ${startPoint} not reachable locally. Fallback to Full Review.`);
            isIncremental = false;
        }
    }
    // 4. 最终回退：全量审查
    if (!isIncremental) {
        startPoint = `origin/${BASE_REF}`;
        console.log(`[INFO] Mode: Full Review (Comparing against ${BASE_REF})`);
        fetchTarget(BASE_REF);
    }
    try {
        console.log(`[INFO] Diff Range: ${startPoint} ... ${endPoint}`);
        // 使用 git diff A B 模式
        const diffCmd = `git diff --name-only "${startPoint}" "${endPoint}"`;
        const diffOutput = (0, node_child_process_1.execSync)(diffCmd, { encoding: 'utf-8' });
        let files = diffOutput.trim().split("\n");
        for (let key in files) {
            const filePath = files[key];
            if (!filePath)
                continue;
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, filePath)))
                continue;
            else if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, filePath)))
                continue;
            const fileDiffCmd = `git diff "${startPoint}" "${endPoint}" -- "${filePath}"`;
            const fileDiffOutput = (0, node_child_process_1.execSync)(fileDiffCmd, { encoding: 'utf-8' });
            const numberedDiff = addLineNumbersToDiff(fileDiffOutput);
            if (numberedDiff.trim().length > 0) {
                items.push({
                    path: filePath,
                    context: numberedDiff,
                });
            }
        }
    }
    catch (error) {
        console.error(`[ERROR] Git diff failed.`, error);
    }
    return { items, isIncremental };
}
// --- 主流程 ---
async function aiCheckDiffContext() {
    try {
        const { items, isIncremental } = await getSmartDiffContext();
        if (items.length === 0) {
            console.log("No changes detected in filtered files. LGTM.");
            return;
        }
        let allComments = [];
        let fileSummaries = [];
        for (let key in items) {
            if (!items[key])
                continue;
            let item = items[key];
            console.log(`[DEBUG] Reviewing file: ${item.path}`);
            try {
                let response = await aiGenerate({
                    host: url,
                    token: process.env.INPUT_AI_TOKEN,
                    prompt: item.context,
                    model: model,
                    system: system_prompt
                });
                if (!response.choices || response.choices.length === 0 || !response.choices[0].message) {
                    console.error("OpenAI response empty for file:", item.path);
                    continue;
                }
                let commit = response.choices[0].message.content;
                commit = commit.trim();
                const match = commit.match(/^```(markdown)?\s*([\s\S]*?)\s*```$/i);
                if (match) {
                    commit = match[2].trim();
                }
                const parsedReview = (0, utils_1.parseAIReviewResponse)(commit);
                if (parsedReview.comments.length > 0) {
                    allComments.push(...parsedReview.comments);
                }
                if (parsedReview.body) {
                    fileSummaries.push({ path: item.path, summary: parsedReview.body });
                }
            }
            catch (e) {
                console.error(`[ERROR] Failed to review ${item.path}:`, e);
            }
        }
        if (allComments.length > 0 || fileSummaries.length > 0) {
            let Review = useChinese ? "审核结果" : "Review";
            const modeLabel = isIncremental ? "(Incremental/增量)" : "(Full/全量)";
            let aggregatedBody = `# ${Review} Summary ${modeLabel}\n\n`;
            if (fileSummaries.length > 0) {
                const summaryContent = fileSummaries.map(s => {
                    const singleLineSummary = s.summary.replace(/\n/g, ' ');
                    return `*   **${s.path}**: ${singleLineSummary}`;
                }).join('\n');
                aggregatedBody += summaryContent;
            }
            let event = (allComments.length === 0 && aggregatedBody.includes("LGTM")) ? 'APPROVE' : 'COMMENT';
            if (allComments.length > 0) {
                event = 'COMMENT';
            }
            else if (fileSummaries.length === 0) {
                console.log("No meaningful content generated. Skipping submit.");
                return;
            }
            console.log(`[INFO] Submitting batch review: ${allComments.length} comments.`);
            let resp = await submitPullRequestReview(aggregatedBody, event, allComments, process.env.GITHUB_SHA);
            if (!resp.id) {
                throw new Error(useChinese ? "提交PR Review失败" : "Submit PR Review error");
            }
            console.log(useChinese ? "提交PR Review成功：" : "Submit PR Review success: ", resp.id);
        }
        else {
            console.log("No review to submit (All files LGTM or empty).");
        }
    }
    catch (error) {
        console.error('Error executing AI check:', error);
        process.exit(1);
    }
}
aiCheckDiffContext()
    .then(_ => console.log(useChinese ? "检查结束" : "review finish"))
    .catch(e => {
    console.error(useChinese ? "检查失败:" : "review error", e);
    process.exit(1);
});
