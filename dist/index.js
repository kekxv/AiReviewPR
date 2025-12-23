"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const prompt_1 = require("./prompt");
function parseAIReviewResponse(aiResponse) {
    const parts = aiResponse.split(/\n---+\n/); // Split by "---" on its own line
    let mainBody = parts[0].trim();
    const lineComments = [];
    for (let i = 0; i < parts.length; i++) {
        const commentPart = parts[i].trim();
        if (!commentPart)
            continue;
        const filePathMatch = commentPart.match(/^File:\s*(.*)$/m);
        const startLineMatch = commentPart.match(/^StartLine:\s*(\d+)$/m);
        const endLineMatch = commentPart.match(/^(?:End)?Line:\s*(\d+)$/m);
        const commentBodyMatch = commentPart.match(/^Comment:\s*([\s\S]*)$/m);
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
        else if (!filePathMatch && !mainBody && commentPart.length > 0 && !commentPart.startsWith("LGTM")) {
            mainBody = commentPart;
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
const url = process.env.INPUT_HOST; // INPUT_HOST 是从 action.yml 中定义的输入
if (!url) {
    console.error('HOST input is required.');
    process.exit(1); // 退出程序，返回错误代码
}
const model = process.env.INPUT_MODEL; // INPUT_HOST 是从 action.yml 中定义的输入
if (!model) {
    console.error('model input is required.');
    process.exit(1); // 退出程序，返回错误代码
}
async function submitPullRequestReview(message, event, comments = [], commit_id) {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
        console.log(message);
        return;
    }
    const body = { body: message, event: event, commit_id: commit_id };
    if (comments.length > 0) {
        body.comments = comments.map(comment => ({
            path: comment.path,
            // The GitHub API expects 'position' for diff-relative line numbers,
            // or 'line' with 'side' for absolute line numbers.
            // Assuming AI provides absolute line numbers in the 'head' (RIGHT) side of the diff.
            line: comment.line,
            side: 'RIGHT',
            start_line: comment.start_line,
            body: comment.body
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
            // noinspection DuplicatedCode
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
        // exec git diff get diff files
        const diffCommand = process.platform === 'win32' ? 'HEAD~1' : 'HEAD^';
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only ${diffCommand}`, { encoding: 'utf-8' });
        let files = diffOutput.trim().split("\n");
        for (let key in files) {
            // noinspection DuplicatedCode
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
        let commit_sha_url = `${process.env.GITHUB_SERVER_URL}/${process.env.INPUT_REPOSITORY}/src/commit/${process.env.GITHUB_SHA}`;
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
