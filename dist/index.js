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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiCheckDiffContext = exports.getDiffItems = exports.getFileDiff = exports.aiGenerate = exports.system_prompt_numbered = exports.addLineNumbersToDiff = void 0;
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const openai_1 = __importDefault(require("openai"));
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
exports.addLineNumbersToDiff = addLineNumbersToDiff;
// --- Inputs ---
const language = process.env.INPUT_LANGUAGE || process.env.LANGUAGE || "Chinese";
let useChinese = language.toLowerCase() === "chinese" || (process.env.INPUT_CHINESE || process.env.CHINESE || "true").toLowerCase() !== "false";
if (language.toLowerCase() !== "chinese" && !process.env.INPUT_CHINESE && !process.env.CHINESE) {
    useChinese = false;
}
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
const include_files = (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || "");
const event_action = process.env.INPUT_EVENT_ACTION || "";
const event_before = process.env.INPUT_EVENT_BEFORE || "";
const force_full_review = (process.env.INPUT_REVIEW_PULL_REQUEST || "false").toLowerCase() === "true";
function system_prompt_numbered(lang) {
    return `
You are a pragmatic Senior Technical Lead. Review the provided git diff FOCUSING on the changed lines (prefixed with '+' or '-').

**INPUT DATA FORMAT:**
You will receive a <git_diff> containing the FULL file content with line numbers. 
Lines prefixed with 'Line X: +' or 'Line X: -' are the changes.
Lines prefixed with 'Line X: ' (with a space after the colon) are context lines.

**REVIEW GUIDELINES:**
1. **Focus:** Review ONLY the changes in <git_diff>. Use context lines to understand variable types and logic flow.
2. **Threshold:** Only report issues with **Score >= 2**. Ignore trivial nits.
3. **NO SUMMARIES:** Do not describe what the code does. Go straight to the issues.
4. **LGTM:** If the code is high quality, output only "LGTM".

**SCORING:**
- [Score: 5] Critical (Security, Crash).
- [Score: 4] Major (Logic, Performance).
- [Score: 3] Moderate (Maintainability).
- [Score: 2] Minor (Optimization).

**OUTPUT FORMAT:**
---
File: <file_path>
Context: <EXACT COPY of the line from the diff starting with "Line X:">
StartLine: <number>
EndLine: <number>
Comment: [Score: <2-5>] <Detailed feedback in ${lang}>
---
`;
}
exports.system_prompt_numbered = system_prompt_numbered;
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
    const openai = new openai_1.default({
        baseURL: host,
        apiKey: token || "ignored",
    });
    const stream = await openai.chat.completions.create({
        model: model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
        ],
        temperature: 0.4,
        stream: true,
    });
    let fullContent = "";
    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
            fullContent += content;
            process.stdout.write(content);
        }
    }
    process.stdout.write("\n");
    return fullContent;
}
exports.aiGenerate = aiGenerate;
// --- Git Logic ---
function getFileDiff(start, end, file) {
    return (0, node_child_process_1.execSync)(`git diff --unified=9999 "${start}" "${end}" -- "${file}"`, { encoding: 'utf-8' });
}
exports.getFileDiff = getFileDiff;
function commitExists(sha) {
    try {
        (0, node_child_process_1.execSync)(`git cat-file -e "${sha}^{commit}"`, { stdio: 'ignore' });
        return true;
    }
    catch (e) {
        return false;
    }
}
function getChangedFiles(start, end) {
    const output = (0, node_child_process_1.execSync)(`git diff --name-only "${start}" "${end}"`, { encoding: 'utf-8' });
    return output.trim().split("\n").filter(f => f);
}
async function getDiffItems() {
    const BASE_REF = process.env.INPUT_BASE_REF || "";
    let startPoint = "";
    const endPoint = "HEAD";
    let isIncremental = false;
    const isSyncEvent = event_action.includes("sync");
    if (!force_full_review && isSyncEvent) {
        if (event_before && event_before !== "null") {
            startPoint = event_before;
            isIncremental = true;
        }
        else {
            const lastReviewedSha = await getLastReviewedCommitId();
            if (lastReviewedSha) {
                startPoint = lastReviewedSha;
                isIncremental = true;
            }
        }
    }
    if (isIncremental && !commitExists(startPoint)) {
        try {
            (0, node_child_process_1.execSync)(`git fetch origin ${startPoint} --depth=1`, { stdio: 'ignore' });
        }
        catch (e) { }
    }
    if (!isIncremental || !commitExists(startPoint)) {
        startPoint = `origin/${BASE_REF}`;
        try {
            (0, node_child_process_1.execSync)(`git fetch origin ${BASE_REF} --depth=1`, { stdio: 'ignore' });
        }
        catch (e) { }
        isIncremental = false;
    }
    let items = [];
    try {
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
    }
    catch (e) { }
    return { items, isIncremental };
}
exports.getDiffItems = getDiffItems;
// --- Main ---
async function aiCheckDiffContext() {
    const url = process.env.INPUT_HOST;
    const model = process.env.INPUT_MODEL;
    if (!url || !model) {
        console.error('HOST and model are required.');
        if (require.main === module)
            process.exit(1);
        return;
    }
    const { items } = await getDiffItems();
    if (items.length === 0)
        return;
    const system_prompt = reviewers_prompt || system_prompt_numbered(language);
    let allComments = [];
    let fileSummaries = [];
    for (const item of items) {
        try {
            const prompt = `
Review the following <git_diff> and output issues in the specified format. If no issues, output "LGTM".

<git_diff>
${item.context}
</git_diff>
`;
            let content = await aiGenerate({
                host: url, token: process.env.INPUT_AI_TOKEN, prompt: prompt, model: model, system: system_prompt
            });
            if (!content)
                continue;
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
            console.error("[ERROR] Failed to review file:", item.path, e);
        }
    }
    if (allComments.length > 0 || fileSummaries.length > 0) {
        let body = `# Review Summary\n\n`;
        if (fileSummaries.length > 0) {
            body += fileSummaries.map(s => `* **${s.path}**: ${s.summary.replace(/\n/g, ' ')}`).join('\n');
        }
        const event = allComments.length > 0 ? 'COMMENT' : 'APPROVE';
        await submitPullRequestReview(body, event, allComments, process.env.GITHUB_SHA);
    }
}
exports.aiCheckDiffContext = aiCheckDiffContext;
if (require.main === module) {
    aiCheckDiffContext().catch(console.error);
}
