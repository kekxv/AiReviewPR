"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const prompt_1 = require("./prompt");
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
async function pushComments(message) {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
        console.log(message);
        return;
    }
    return await (0, utils_1.post)({
        url: `${process.env.GITHUB_API_URL}/repos/${process.env.INPUT_REPOSITORY}/issues/${process.env.INPUT_PULL_REQUEST_NUMBER}/comments`,
        body: { body: message },
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
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only HEAD^`, { encoding: 'utf-8' });
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
            const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff HEAD^ -- "${files[key]}"`, { encoding: 'utf-8' });
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
                    system: process.env.INPUT_REVIEW_PROMPT
                });
                if (!response.choices || response.choices.length === 0 || !response.choices[0].message) {
                    console.error("OpenAI response error:", response);
                    throw "OpenAI/Ollama response error";
                }
                let Review = useChinese ? "审核结果" : "Review";
                let commit = response.choices[0].message.content;
                // Greedy parsing: Try to strip markdown code block wrapper if present
                commit = commit.trim();
                const match = commit.match(/^```(markdown)?\s*([\s\S]*?)\s*```$/i);
                if (match) {
                    commit = match[2];
                }
                let comments = `# ${Review} \r\n${commit_sha_url}/${item.path} \r\n\r\n\r\n${commit}`;
                let resp = await pushComments(comments);
                if (!resp.id) {
                    // noinspection ExceptionCaughtLocallyJS
                    throw new Error(useChinese ? "提交issue评论失败" : "push comment error");
                }
                console.log(useChinese ? "提交issue评论成功：" : "push comment success: ", resp.id);
            }
            catch (e) {
                console.error("aiGenerate:", e);
            }
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
