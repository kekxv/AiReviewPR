"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
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
            // 这里的改变：加了 "Line " 前缀，更醒目
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
let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false";
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese";
const include_files = (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || "");
const review_pull_request = (!process.env.INPUT_REVIEW_PULL_REQUEST) ? false : (process.env.INPUT_REVIEW_PULL_REQUEST.toLowerCase() === "true");
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
            // --- FIX 3: 严格匹配 Gitea Swagger，移除 side 参数 ---
            return {
                path: comment.path,
                new_position: comment.line,
                // 移除 side: "RIGHT" 防止兼容性问题
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
    if (token)
        headers['Authorization'] = `Bearer ${token}`;
    return await (0, utils_1.post)({ url: endpoint, body: data, header: headers });
}
async function getPrDiffContext() {
    let items = [];
    const BASE_REF = process.env.INPUT_BASE_REF;
    try {
        (0, node_child_process_1.execSync)(`git fetch origin ${BASE_REF}`, { encoding: 'utf-8' });
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only origin/${BASE_REF}...HEAD`, { encoding: 'utf-8' });
        let files = diffOutput.trim().split("\n");
        for (let key in files) {
            if (!files[key])
                continue;
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, files[key])))
                continue;
            else if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, files[key])))
                continue;
            const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff origin/${BASE_REF}...HEAD -- "${files[key]}"`, { encoding: 'utf-8' });
            // --- FIX 4: 调用预处理函数 ---
            const numberedDiff = addLineNumbersToDiff(fileDiffOutput);
            items.push({
                path: files[key],
                context: numberedDiff, // 发送带行号的 Diff 给 AI
            });
        }
    }
    catch (error) {
        console.error('Error executing git diff:', error);
    }
    return items;
}
async function getHeadDiffContext() {
    let items = [];
    try {
        const diffCommand = process.platform === 'win32' ? 'HEAD~1' : 'HEAD^';
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only ${diffCommand}`, { encoding: 'utf-8' });
        let files = diffOutput.trim().split("\n");
        for (let key in files) {
            if (!files[key])
                continue;
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, files[key])))
                continue;
            else if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, files[key])))
                continue;
            const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff ${diffCommand} -- "${files[key]}"`, { encoding: 'utf-8' });
            // --- FIX 4: 调用预处理函数 ---
            const numberedDiff = addLineNumbersToDiff(fileDiffOutput);
            items.push({
                path: files[key],
                context: numberedDiff,
            });
        }
    }
    catch (error) {
        console.error('Error executing git diff:', error);
    }
    return items;
}
async function aiCheckDiffContext() {
    try {
        let items = review_pull_request ? await getPrDiffContext() : await getHeadDiffContext();
        let allComments = [];
        // --- 修改点 1: 创建一个新的数组来分别存储文件总结 ---
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
                    console.error("OpenAI response error:", response);
                    throw "OpenAI/Ollama response error";
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
                // --- 修改点 2: 将文件路径和总结作为对象存入新数组 ---
                if (parsedReview.body) {
                    fileSummaries.push({ path: item.path, summary: parsedReview.body });
                }
            }
            catch (e) {
                console.error("aiGenerate:", e);
            }
        }
        // Batch Submit
        if (allComments.length > 0 || fileSummaries.length > 0) {
            let Review = useChinese ? "审核结果" : "Review";
            let aggregatedBody = `# ${Review} Summary\n\n`;
            // --- 修改点 3: 格式化总结为一个 Markdown 列表 ---
            if (fileSummaries.length > 0) {
                const summaryContent = fileSummaries.map(s => {
                    // 将多行总结合并为一行，使其在列表中更好看
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
                console.log("No review content generated. Skipping.");
                return;
            }
            console.log(`[INFO] Submitting batch review with ${allComments.length} comments.`);
            let resp = await submitPullRequestReview(aggregatedBody, event, allComments, process.env.GITHUB_SHA);
            if (!resp.id) {
                throw new Error(useChinese ? "提交PR Review失败" : "Submit PR Review error");
            }
            console.log(useChinese ? "提交PR Review成功：" : "Submit PR Review success: ", resp.id);
        }
        else {
            console.log("No review to submit (LGTM or empty).");
        }
    }
    catch (error) {
        console.error('Error executing git diff:', error);
        process.exit(1); // error exit
    }
}
aiCheckDiffContext()
    .then(_ => console.log(useChinese ? "检查结束" : "review finish"))
    .catch(e => {
    console.error(useChinese ? "检查失败:" : "review error", e);
    process.exit(1);
});
