"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const prompt_1 = require("./prompt");
// --- FIX 1: 重写解析逻辑 ---
// 解决 "开头的解析也不太对" 和 "第一条评论未识别导致行号失效" 的问题
function parseAIReviewResponse(aiResponse) {
    // 允许 --- 前后有换行符
    const parts = aiResponse.split(/\n\s*---+\s*\n/);
    let mainBody = "";
    const lineComments = [];
    for (let i = 0; i < parts.length; i++) {
        const commentPart = parts[i].trim();
        if (!commentPart)
            continue;
        // 尝试匹配结构化评论
        // 使用 multiline 模式 (^...$m) 确保匹配行首行尾
        const filePathMatch = commentPart.match(/^File:\s*(.*)$/m);
        const startLineMatch = commentPart.match(/^StartLine:\s*(\d+)$/m);
        const endLineMatch = commentPart.match(/^(?:End)?Line:\s*(\d+)$/m);
        const commentBodyMatch = commentPart.match(/^Comment:\s*([\s\S]*)$/m);
        // 只有当核心字段都存在时，才视为代码评论
        if (filePathMatch && endLineMatch && commentBodyMatch) {
            const line = parseInt(endLineMatch[1]);
            const start_line = startLineMatch ? parseInt(startLineMatch[1]) : line;
            lineComments.push({
                path: filePathMatch[1].trim(),
                line: line,
                start_line: start_line !== line ? start_line : undefined,
                body: commentBodyMatch[1].trim()
            });
        }
        else {
            // 既不是结构化评论，也不是空的，且不单纯是 "LGTM"，则归为 Summary
            // 防止 Summary 把 "File:..." 这种元数据吃进去
            if (!commentPart.startsWith("File:") && !commentPart.startsWith("LGTM")) {
                if (mainBody) {
                    mainBody += "\n\n" + commentPart;
                }
                else {
                    mainBody = commentPart;
                }
            }
        }
    }
    return { body: mainBody, comments: lineComments };
}
let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false"; // use chinese
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese";
const include_files = (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || "");
const review_pull_request = (!process.env.INPUT_REVIEW_PULL_REQUEST) ? false : (process.env.INPUT_REVIEW_PULL_REQUEST.toLowerCase() === "true");
const system_prompt = reviewers_prompt || (0, prompt_1.take_system_prompt)(prompt_genre, language);
// 获取输入参数
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
            // 因为 Gitea Swagger 定义里只有 new_position/old_position，没有 start_line 字段
            // 所以我们把行号范围写在评论内容里
            if (comment.start_line && comment.start_line !== comment.line) {
                commentBody = `[Lines ${comment.start_line}-${comment.line}] ${commentBody}`;
            }
            // --- FIX 2: 严格按照 Swagger 定义 ---
            return {
                path: comment.path,
                new_position: comment.line,
                body: commentBody
                // Gitea 默认为新文件/修改后的行，不需要传 old_position 除非是针对删除行的评论
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
    if (!endpoint.endsWith("/")) {
        endpoint += "/";
    }
    // Try to adapt to standard OpenAI Base URL format
    if (!endpoint.includes("/v1/")) {
        endpoint += "v1/";
    }
    endpoint += "chat/completions";
    console.log(`[DEBUG] aiGenerate calling endpoint: ${endpoint}, model: ${model}`);
    const data = JSON.stringify({
        model: model,
        messages: [
            { role: "system", content: system || system_prompt },
            { role: "user", content: prompt }
        ],
        temperature: 0.7,
        top_p: 1,
    });
    const headers = {};
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return await (0, utils_1.post)({
        url: endpoint,
        body: data,
        header: headers
    });
}
async function getPrDiffContext() {
    let items = [];
    const BASE_REF = process.env.INPUT_BASE_REF;
    try {
        (0, node_child_process_1.execSync)(`git fetch origin ${BASE_REF}`, { encoding: 'utf-8' });
        // exec git diff get diff files
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only origin/${BASE_REF}...HEAD`, { encoding: 'utf-8' });
        let files = diffOutput.trim().split("\n");
        for (let key in files) {
            if (!files[key])
                continue;
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, files[key]))) {
                console.log("exclude(include):", files[key]);
                continue;
            }
            else if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, files[key]))) {
                console.log("exclude(exclude):", files[key]);
                continue;
            }
            const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff origin/${BASE_REF}...HEAD -- "${files[key]}"`, { encoding: 'utf-8' });
            items.push({
                path: files[key],
                context: fileDiffOutput,
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
            if ((include_files.length > 0) && (!(0, utils_1.doesAnyPatternMatch)(include_files, files[key]))) {
                console.log("exclude(include):", files[key]);
                continue;
            }
            else if ((exclude_files.length > 0) && ((0, utils_1.doesAnyPatternMatch)(exclude_files, files[key]))) {
                console.log("exclude(exclude):", files[key]);
                continue;
            }
            const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff ${diffCommand} -- "${files[key]}"`, { encoding: 'utf-8' });
            items.push({
                path: files[key],
                context: fileDiffOutput,
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
        let allReviewBodies = [];
        for (let key in items) {
            if (!items[key])
                continue;
            let item = items[key];
            console.log(`[DEBUG] Reviewing file: ${item.path}`);
            // ai generate
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
                // Greedy parsing: Try to strip markdown code block wrapper if present
                commit = commit.trim();
                const match = commit.match(/^```(markdown)?\s*([\s\S]*?)\s*```$/i);
                if (match) {
                    commit = match[2].trim();
                }
                const parsedReview = parseAIReviewResponse(commit);
                if (parsedReview.comments.length > 0) {
                    allComments.push(...parsedReview.comments);
                }
                // 只有当有实质性内容时才添加到 Summary
                if (parsedReview.body) {
                    allReviewBodies.push(`\n\n**File: ${item.path}**\n${parsedReview.body}`);
                }
            }
            catch (e) {
                console.error("aiGenerate:", e);
            }
        }
        // Batch Submit
        if (allComments.length > 0 || allReviewBodies.length > 0) {
            let Review = useChinese ? "审核结果" : "Review";
            let aggregatedBody = `# ${Review} Summary\n` + allReviewBodies.join("\n---\n");
            let event = (allComments.length === 0 && aggregatedBody.includes("LGTM")) ? 'APPROVE' : 'COMMENT';
            if (allComments.length > 0) {
                event = 'COMMENT';
            }
            else if (allReviewBodies.length === 0) {
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
