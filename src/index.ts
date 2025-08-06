import {execSync} from "node:child_process";
import {doesAnyPatternMatch, post, split_message} from "./utils";
import {take_system_prompt} from "./prompt";

let useChinese = (process.env.INPUT_CHINESE || "true").toLowerCase() != "false"; // use chinese
const language = !process.env.INPUT_CHINESE ? (process.env.INPUT_LANGUAGE || "Chinese") : (useChinese ? "Chinese" : "English");
const prompt_genre = (process.env.INPUT_PROMPT_GENRE || "");
const reviewers_prompt = (process.env.INPUT_REVIEWERS_PROMPT || "");
useChinese = language.toLowerCase() === "chinese"
const include_files = split_message(process.env.INPUT_INCLUDE_FILES || "");
const exclude_files = split_message(process.env.INPUT_EXCLUDE_FILES || "");
const review_pull_request = (!process.env.INPUT_REVIEW_PULL_REQUEST) ? false : (process.env.INPUT_REVIEW_PULL_REQUEST.toLowerCase() === "true")

const system_prompt = reviewers_prompt || take_system_prompt(prompt_genre, language);

// 获取输入参数
const url = process.env.INPUT_HOST; // INPUT_HOST 是从 action.yml 中定义的输入
if (!url) {
  console.error('HOST input is required.');
  process.exit(1);  // 退出程序，返回错误代码
}
const model = process.env.INPUT_MODEL; // INPUT_HOST 是从 action.yml 中定义的输入
if (!model) {
  console.error('model input is required.');
  process.exit(1);  // 退出程序，返回错误代码
}


async function pushComments(message: string): Promise<any> {
  if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
    console.log(message);
    return;
  }
  return await post({
    url: `${process.env.GITHUB_API_URL}/repos/${process.env.INPUT_REPOSITORY}/issues/${process.env.INPUT_PULL_REQUEST_NUMBER}/comments`,
    body: {body: message},
    header: {'Authorization': `token ${process.env.INPUT_TOKEN}`}
  })
}

async function aiGenerate({host, token, prompt, model, system}: any): Promise<any> {
  const data = JSON.stringify({
    prompt: prompt,
    model: model,
    stream: false,
    system: system || system_prompt,
    options: {
      tfs_z: 1.5,
      top_k: 30,
      top_p: 0.8,
      temperature: 0.7,
      num_ctx: 10240,
    }
  });
  return await post({
    url: `${host}/api/generate`,
    body: data,
    header: {'Authorization': token ? `Bearer ${token}` : "",}
  })
}

async function getPrDiffContext() {
  let items = [];
  const BASE_REF = process.env.INPUT_BASE_REF
  try {
    execSync(`git fetch origin ${BASE_REF}`, {encoding: 'utf-8'});
    // exec git diff get diff files
    const diffOutput = execSync(`git diff --name-only origin/${BASE_REF}...HEAD`, {encoding: 'utf-8'});
    let files = diffOutput.trim().split("\n");
    for (let key in files) {
      // noinspection DuplicatedCode
      if (!files[key]) continue;
      if ((include_files.length > 0) && (!doesAnyPatternMatch(include_files, files[key]))) {
        console.log("exclude(include):", files[key])
        continue;
      } else if ((exclude_files.length > 0) && (doesAnyPatternMatch(exclude_files, files[key]))) {
        console.log("exclude(exclude):", files[key])
        continue;
      }

      const fileDiffOutput = execSync(`git diff origin/${BASE_REF}...HEAD -- "${files[key]}"`, {encoding: 'utf-8'});
      items.push({
        path: files[key],
        context: fileDiffOutput,
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
    // exec git diff get diff files
    const diffOutput = execSync(`git diff --name-only HEAD^`, {encoding: 'utf-8'});
    let files = diffOutput.trim().split("\n");
    for (let key in files) {
      // noinspection DuplicatedCode
      if (!files[key]) continue;
      if ((include_files.length > 0) && (!doesAnyPatternMatch(include_files, files[key]))) {
        console.log("exclude(include):", files[key])
        continue;
      } else if ((exclude_files.length > 0) && (doesAnyPatternMatch(exclude_files, files[key]))) {
        console.log("exclude(exclude):", files[key])
        continue;
      }

      const fileDiffOutput = execSync(`git diff HEAD^ -- "${files[key]}"`, {encoding: 'utf-8'});
      items.push({
        path: files[key],
        context: fileDiffOutput,
      })
    }
  } catch (error) {
    console.error('Error executing git diff:', error);
  }
  return items;
}

async function aiCheckDiffContext() {
  try {
    let commit_sha_url = `${process.env.GITHUB_SERVER_URL}/${process.env.INPUT_REPOSITORY}/src/commit/${process.env.GITHUB_SHA}`;
    let items: Array<any> = review_pull_request ? await getPrDiffContext() : await getHeadDiffContext();
    for (let key in items) {
      if (!items[key]) continue;
      let item = items[key];
      // ai generate
      try {
        let response = await aiGenerate({
          host: url,
          token: process.env.INPUT_AI_TOKEN,
          prompt: item.context,
          model: model,
          system: process.env.INPUT_REVIEW_PROMPT
        })
        if (response.detail) { // noinspection ExceptionCaughtLocallyJS
          throw response.detail;
        }
        if (!response.response) { // noinspection ExceptionCaughtLocallyJS
          throw "ollama error";
        }
        let Review = useChinese ? "审核结果" : "Review";
        let commit: string = response.response;
        if (commit.indexOf("```markdown") === 0) {
          commit = commit.substring("```markdown".length);
          if (commit.lastIndexOf("```") === commit.length - 3) {
            commit = commit.substring(0, commit.length - 3);
          }
        }
        let comments = `# ${Review} \r\n${commit_sha_url}/${item.path} \r\n\r\n\r\n${commit}`
        let resp = await pushComments(comments);
        if (!resp.id) {
          // noinspection ExceptionCaughtLocallyJS
          throw new Error(useChinese ? "提交issue评论失败" : "push comment error")
        }
        console.log(useChinese ? "提交issue评论成功：" : "push comment success: ", resp.id)
      } catch (e) {
        console.error("aiGenerate:", e)
      }
    }
  } catch (error) {
    console.error('Error executing git diff:', error);
    process.exit(1);  // error exit
  }
}

aiCheckDiffContext()
  .then(_ => console.log(useChinese ? "检查结束" : "review finish"))
  .catch(e => {
    console.error(useChinese ? "检查失败:" : "review error", e);
    process.exit(1);
  });
