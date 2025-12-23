import {execSync} from "node:child_process";
import {doesAnyPatternMatch, post, split_message} from "./utils";
import {take_system_prompt} from "./prompt";

function addLineNumbersToDiff(diff: string): string {
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
      if (currentNewLine !== null) currentNewLine++;
    } else if (line.startsWith(' ')) {
      result.push(`Line ${currentNewLine}: ${line}`);
      if (currentNewLine !== null) currentNewLine++;
    } else if (line.startsWith('-')) {
      result.push(`OLD: ${line}`);
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

function parseAIReviewResponse(aiResponse: string): { body: string, comments: Array<{ path: string, line: number, start_line?: number, body: string }> } {
  const parts = aiResponse.split(/\n\s*---+\s*\n/);
  let mainBody = "";
  const lineComments: Array<{ path: string, line: number, start_line?: number, body: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    const commentPart = parts[i].trim();
    if (!commentPart) continue;

    // --- 正则优化 ---
    // 1. 忽略大小写 (i flag)
    // 2. 允许英文冒号(:) 或 中文冒号(：)
    // 3. 兼容 AI 有时候会把 Key 翻译的情况 (但主要靠 Prompt 约束)
    const filePathMatch = commentPart.match(/^(?:File|文件)\s*[:：]\s*(.*)$/im);
    const contextMatch = commentPart.match(/^(?:Context|内容|上下文)\s*[:：]\s*(.*)$/im); // 虽不使用但需兼容格式
    const startLineMatch = commentPart.match(/^(?:StartLine|Start\s*Line|起始行号|开始行号)\s*[:：]\s*(\d+)$/im);
    const endLineMatch = commentPart.match(/^(?:(?:End)?Line|End\s*Line|结束行号)\s*[:：]\s*(\d+)$/im);
    const commentBodyMatch = commentPart.match(/^(?:Comment|Review|评论|注释)\s*[:：]\s*([\s\S]*)$/im);

    if (filePathMatch && endLineMatch && commentBodyMatch) {
      const line = parseInt(endLineMatch[1]);
      const start_line = startLineMatch ? parseInt(startLineMatch[1]) : line;

      lineComments.push({
        path: filePathMatch[1].trim(),
        line: line,
        start_line: start_line !== line ? start_line : undefined,
        body: commentBodyMatch[1].trim()
      });
    } else {
      // 如果匹配不到 Key，归为 Summary
      // 过滤掉单纯的 "LGTM" 或疑似 Key 的行
      if (!commentPart.match(/^File[:：]/i) && !commentPart.startsWith("LGTM")) {
        if (mainBody) mainBody += "\n\n" + commentPart;
        else mainBody = commentPart;
      }
    }
  }
  return { body: mainBody, comments: lineComments };
}

let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false";
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese"
const include_files = split_message(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = split_message(process.env.INPUT_EXCLUDE_FILES || "");
const review_pull_request = (!process.env.INPUT_REVIEW_PULL_REQUEST) ? false : (process.env.INPUT_REVIEW_PULL_REQUEST.toLowerCase() === "true")

function system_prompt_numbered(language: string) {
  return `
You are a senior code reviewer. Review the provided git diffs.

**IMPORTANT: The code has been pre-processed with line numbers (e.g., "Line 12: + const a = 1;").**

**STRICT RULES:**
1. **Line Validation:** You MUST verify the line number matches the code. Copy the exact code into the "Context" field.
2. **Language:** Write the *content* of the comments in ${language}.
3. **Format Keys:** **KEEP ALL KEYS IN ENGLISH** (File, Context, StartLine, EndLine, Comment). **DO NOT TRANSLATE KEYS.**
4. **Separators:** Use '---' strictly between issues.

**Instructions:**
1. **Summary:** First, provide a brief summary of changes in ${language}.
2. **Issues:** List specific issues using the strict format below.

**Strict Output Format:**

<Summary text here...>

---
File: <file_path>
Context: <COPY the exact code line from the diff here>
StartLine: <number>
EndLine: <number>
Comment: [Score: 1-5] <comment content in ${language}>
---

**Example:**
---
File: src/main.js
Context: Line 10: + console.log("debug");
StartLine: 10
EndLine: 10
Comment: [Score: 2] 生产环境不建议保留 console.log，建议删除。
---
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


async function submitPullRequestReview(
  message: string,
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
  comments: Array<{ path: string; line: number; start_line?: number; body: string }> = [],
  commit_id: string
): Promise<any> {
  if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
    console.log(message);
    return {id: 0};
  }

  const body: any = {
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
        new_position: comment.line, // 使用 new_position
        // 移除 side: "RIGHT" 防止兼容性问题
        body: commentBody
      };
    });
  }

  return await post({
    url: `${process.env.GITHUB_API_URL}/repos/${process.env.INPUT_REPOSITORY}/pulls/${process.env.INPUT_PULL_REQUEST_NUMBER}/reviews`,
    body: body,
    header: {'Authorization': `token ${process.env.INPUT_TOKEN}`}
  });
}

async function aiGenerate({host, token, prompt, model, system}: any): Promise<any> {
  let endpoint = host;
  if (!endpoint.endsWith("/")) endpoint += "/";
  if (!endpoint.includes("/v1/")) endpoint += "v1/";
  endpoint += "chat/completions";

  const data = JSON.stringify({
    model: model,
    messages: [
      {role: "system", content: system},
      {role: "user", content: prompt}
    ],
    temperature: 0.7,
    top_p: 1,
  });

  const headers: any = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return await post({url: endpoint, body: data, header: headers})
}

async function getPrDiffContext() {
  let items = [];
  const BASE_REF = process.env.INPUT_BASE_REF
  try {
    execSync(`git fetch origin ${BASE_REF}`, {encoding: 'utf-8'});
    const diffOutput = execSync(`git diff --name-only origin/${BASE_REF}...HEAD`, {encoding: 'utf-8'});
    let files = diffOutput.trim().split("\n");
    for (let key in files) {
      if (!files[key]) continue;
      if ((include_files.length > 0) && (!doesAnyPatternMatch(include_files, files[key]))) continue;
      else if ((exclude_files.length > 0) && (doesAnyPatternMatch(exclude_files, files[key]))) continue;

      const fileDiffOutput = execSync(`git diff origin/${BASE_REF}...HEAD -- "${files[key]}"`, {encoding: 'utf-8'});
      // --- FIX 4: 调用预处理函数 ---
      const numberedDiff = addLineNumbersToDiff(fileDiffOutput);
      items.push({
        path: files[key],
        context: numberedDiff, // 发送带行号的 Diff 给 AI
      })
    }
  } catch (error) {
    console.error('Error executing git diff:', error);
  }
  return items;
}

async function getHeadDiffContext() {
  let items = [];
  try {
    const diffCommand = process.platform === 'win32' ? 'HEAD~1' : 'HEAD^';
    const diffOutput = execSync(`git diff --name-only ${diffCommand}`, {encoding: 'utf-8'});
    let files = diffOutput.trim().split("\n");
    for (let key in files) {
      if (!files[key]) continue;
      if ((include_files.length > 0) && (!doesAnyPatternMatch(include_files, files[key]))) continue;
      else if ((exclude_files.length > 0) && (doesAnyPatternMatch(exclude_files, files[key]))) continue;

      const fileDiffOutput = execSync(`git diff ${diffCommand} -- "${files[key]}"`, {encoding: 'utf-8'});
      // --- FIX 4: 调用预处理函数 ---
      const numberedDiff = addLineNumbersToDiff(fileDiffOutput);
      items.push({
        path: files[key],
        context: numberedDiff,
      })
    }
  } catch (error) {
    console.error('Error executing git diff:', error);
  }
  return items;
}

async function aiCheckDiffContext() {
  try {
    let items: Array<any> = review_pull_request ? await getPrDiffContext() : await getHeadDiffContext();
    let allComments: Array<{ path: string, line: number, start_line?: number, body: string }> = [];
    let allReviewBodies: string[] = [];

    for (let key in items) {
      if (!items[key]) continue;
      let item = items[key];
      console.log(`[DEBUG] Reviewing file: ${item.path}`);
      try {
        let response = await aiGenerate({
          host: url,
          token: process.env.INPUT_AI_TOKEN,
          prompt: item.context,
          model: model,
          system: system_prompt
        })

        if (!response.choices || response.choices.length === 0 || !response.choices[0].message) {
          throw "OpenAI/Ollama response error";
        }

        let commit: string = response.choices[0].message.content;
        commit = commit.trim();
        const match = commit.match(/^```(markdown)?\s*([\s\S]*?)\s*```$/i);
        if (match) commit = match[2].trim();

        const parsedReview = parseAIReviewResponse(commit);
        if (parsedReview.comments.length > 0) allComments.push(...parsedReview.comments);
        if (parsedReview.body) allReviewBodies.push(`\n\n**File: ${item.path}**\n${parsedReview.body}`);

      } catch (e) {
        console.error("aiGenerate:", e)
      }
    }

    if (allComments.length > 0 || allReviewBodies.length > 0) {
      let Review = useChinese ? "审核结果" : "Review";
      let aggregatedBody = `# ${Review} Summary\n` + allReviewBodies.join("\n---\n");
      let event: 'APPROVE' | 'COMMENT' = (allComments.length === 0 && aggregatedBody.includes("LGTM")) ? 'APPROVE' : 'COMMENT';

      if (allComments.length > 0) event = 'COMMENT';
      else if (allReviewBodies.length === 0) {
        console.log("Skipping.");
        return;
      }

      console.log(`[INFO] Submitting batch review with ${allComments.length} comments.`);
      let resp = await submitPullRequestReview(aggregatedBody, event, allComments, process.env.GITHUB_SHA as string);
      if (!resp.id) throw new Error("Submit PR Review error")
      console.log("Submit PR Review success: ", resp.id)
    } else {
      console.log("No review to submit.");
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

aiCheckDiffContext()
  .then(_ => console.log(useChinese ? "检查结束" : "review finish"))
  .catch(e => {
    console.error(useChinese ? "检查失败:" : "review error", e);
    process.exit(1);
  });

