import {execSync} from "node:child_process";
import {doesAnyPatternMatch, post, split_message} from "./utils";
import {take_system_prompt} from "./prompt";

// --- FIX 1: 增加 Diff 行号预处理函数 ---
// 这一步至关重要，它帮 AI 算好了行号，防止 AI 幻觉
function addLineNumbersToDiff(diff: string): string {
  const lines = diff.split('\n');
  let result = [];
  let currentNewLine = null;

  for (let line of lines) {
    // 解析 Diff Header，例如 @@ -2,25 +2,25 @@
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

    // 处理变更行和上下文行
    if (line.startsWith('+')) {
      // 新增行：标记行号
      result.push(`${currentNewLine}: ${line}`);
      if (currentNewLine !== null) currentNewLine++;
    } else if (line.startsWith(' ')) {
      // 上下文行：标记行号
      result.push(`${currentNewLine}: ${line}`);
      if (currentNewLine !== null) currentNewLine++;
    } else if (line.startsWith('-')) {
      // 删除行：没有新文件行号，标记为 OLD
      result.push(`OLD: ${line}`);
      // 删除行不增加新文件的行号计数
    } else {
      // 其他元数据
      result.push(line);
    }
  }
  return result.join('\n');
}

function parseAIReviewResponse(aiResponse: string): {
  body: string,
  comments: Array<{ path: string, line: number, start_line?: number, body: string }>
} {
  const parts = aiResponse.split(/\n\s*---+\s*\n/);
  let mainBody = "";
  const lineComments: Array<{ path: string, line: number, start_line?: number, body: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    const commentPart = parts[i].trim();
    if (!commentPart) continue;

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
    } else {
      if (!commentPart.startsWith("File:") && !commentPart.startsWith("LGTM")) {
        if (mainBody) mainBody += "\n\n" + commentPart;
        else mainBody = commentPart;
      }
    }
  }
  return {body: mainBody, comments: lineComments};
}

let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false";
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese"
const include_files = split_message(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = split_message(process.env.INPUT_EXCLUDE_FILES || "");
const review_pull_request = (!process.env.INPUT_REVIEW_PULL_REQUEST) ? false : (process.env.INPUT_REVIEW_PULL_REQUEST.toLowerCase() === "true")

// --- FIX 2: 更新 Prompt 提示，告诉 AI 我们加了行号 ---
function system_prompt_numbered(language: string) {
  return `
You are a senior code reviewer. Review the provided git diffs.

**IMPORTANT: The code provided has specific line numbers prepended to each line (e.g., "12: + const a = 1;").**
**You MUST use these exact numbers for 'StartLine' and 'EndLine'.**

**Instructions:**
1. **Summary:** Provide a brief summary of changes.
2. **Analyze:** Focus on logic, security, and best practices.
3. **Format:** Use the following format for issues:

---
File: <file_path>
StartLine: <line_number_from_diff_prefix>
EndLine: <line_number_from_diff_prefix>
Comment: [Score: 1-5] <comment>
---

4. **Constraints:**
    - Language: ${language}
    - Only review changed lines.
    - If no issues, output "LGTM".
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

