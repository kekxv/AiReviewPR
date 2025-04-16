# 基于 Gitea 和 Ollama (open-webui) 的代码合并自动检查

如果您需要对合并的代码进行审核，但又希望避免将代码发送给第三方，或者您的网络环境处于离线状态（无法连接到第三方平台），那么本项目将是一个理想的选择。

该项目结合了 Gitea 和 Ollama (open-webui)，能够自动审核合并代码，并将结果通过评论的形式推送到相应的合并请求中，供开发人员或审核人员参考使用。

# Automatic Code Merge Checks Based on Gitea and Ollama (open-webui)

If you need to review your merged code but prefer not to send it to a third party, or if your network environment is offline (unable to connect to third-party platforms), then this project is an ideal choice.

This project integrates Gitea and Ollama (open-webui) to automatically review merged code and push the results as comments to the corresponding merge requests, allowing developers or reviewers to reference them.


- [如何使用 How to use](#如何使用-How-to-use)
- [输入参数](#输入参数)
- [Input Parameters](#input-parameters)

# 如何使用 How to use

使用方式和普通的 github actions 没什么区别(gitea actions 基本兼容 github actions)。

The usage is similar to regular GitHub Actions (Gitea Actions are mostly compatible with GitHub Actions).

需要设置一个 ollama host，如果使用的是 open-webui ，建议加上授权token。

You need to set up an Ollama host, and if you are using open-webui, it is recommended to include an authorization token.

```yaml
name: ai-reviews

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    name: Review PR
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Review code
        uses: kekxv/AiReviewPR@v0.0.5
        with:
          model: 'gemma2:2b'
          host: ${{ vars.OLLAMA_HOST }}
          ai_token: ${{ secrets.AI_TOKEN }}
          REVIEW_PULL_REQUEST: false
          exclude_files: |
            ^.+\.md
            test2\.js
```

效果如下：

result：

![actions.run.png](assets/actions.run.png)
![review.comments.1.png](assets/review.comments.1.png)
![review.comments.2.png](assets/review.comments.2.png)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=kekxv/AiReviewPR&type=Date)](https://star-history.com/#kekxv/AiReviewPR&Date)


## 输入参数


1. **repository**
  - **描述**: 存储库名称，格式为 `owner/repo`（例如 `actions/checkout`）。
  - **默认值**: `${{ github.repository }}`（当前 GitHub 仓库的名称）。

2. **REVIEW_PULL_REQUEST**
  - **描述**: 指定是否要比较从提交开始到最新的记录；设置为 `false` 表示只审核最新一次提交。
  - **默认值**: `false`。

3. **BASE_REF**
  - **描述**: 当前 GitHub 事件中的 pull_request 的基准分支。
  - **默认值**: `${{ github.event.pull_request.base.ref }}`。

4. **PULL_REQUEST_NUMBER**
  - **描述**: 当前 GitHub 事件中的 pull_request 编号。
  - **默认值**: `${{ github.event.pull_request.number }}`。

5. **CHINESE**
  - **描述**: 使用中文（作废）。
  - **默认值**: `""`。

6. **LANGUAGE**
  - **描述**: 使用语言（中文）。
  - **默认值**: `"Chinese"`。

7. **token**
  - **描述**: 用于访问存储库的个人访问令牌（PAT）。该令牌配置在本地 git 配置中，允许脚本运行经过身份验证的 git 命令。作业结束时会移除 PAT。
  - **建议**: 使用权限最少的服务账号生成新的 PAT 并仅选择必要的作用域。
  - **文档链接**: [了解如何创建和使用加密密钥](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/creating-and-using-encrypted-secrets)。
  - **默认值**: `${{ github.token }}`。

8. **model**
  - **描述**: 用于代码审核的 AI 模型。
  - **必需**: 是。
  - **默认值**: `'gemma2:2b'`。

9. **host**
  - **描述**: Ollama 主机地址。
  - **必需**: 是。
  - **默认值**: `'http://127.0.0.1:11434'`。

10. **PROMPT_GENRE**
  - **描述**: 提示生成的类型。
  - **默认值**: `' '`（空格）。

11. **reviewers_prompt**
  - **描述**: Ollama 系统提示信息。
  - **必需**: 否。
  - **默认值**: `""`（空字符串）。

12. **ai_token**
  - **描述**: AI 令牌。
  - **必需**: 否。
  - **默认值**: `" "`（空格）。

13. **include_files**
  - **描述**: 要包括审查的文件的以逗号分隔的列表。
  - **必需**: 否。
  - **默认值**: `" "`（默认为空，表示不限制）。

14. **exclude_files**
  - **描述**: 要排除审查的文件的以逗号分隔的列表。
  - **必需**: 否。
  - **默认值**: `" "`（默认为空，表示不传递文件）。



### Input Parameters

1. **repository**
  - **Description**: The name of the repository, formatted as `owner/repo` (e.g., `actions/checkout`).
  - **Default Value**: `${{ github.repository }}` (the name of the current GitHub repository).

2. **REVIEW_PULL_REQUEST**
  - **Description**: Specifies whether to compare the records from the beginning of the commit to the latest one; setting it to `false` means that only the most recent commit will be reviewed.
  - **Default Value**: `false`.

3. **BASE_REF**
  - **Description**: The base branch of the pull request in the current GitHub event.
  - **Default Value**: `${{ github.event.pull_request.base.ref }}`.

4. **PULL_REQUEST_NUMBER**
  - **Description**: The number of the pull request in the current GitHub event.
  - **Default Value**: `${{ github.event.pull_request.number }}`.

5. **CHINESE**
  - **Description**: Use Chinese (deprecated).
  - **Default Value**: `""`.

6. **LANGUAGE**
  - **Description**: Language to use (Chinese).
  - **Default Value**: `"Chinese"`.

7. **token**
  - **Description**: Personal access token (PAT) used to access the repository. The PAT is configured in the local git configuration, allowing your scripts to run authenticated git commands. The PAT will be removed at the end of the job.
  - **Recommendation**: Use a service account with the least permissions necessary when generating a new PAT and select only the minimum required scopes.
  - **Documentation Link**: [Learn more about creating and using encrypted secrets](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/creating-and-using-encrypted-secrets).
  - **Default Value**: `${{ github.token }}`.

8. **model**
  - **Description**: AI model to use for code review.
  - **Required**: Yes.
  - **Default Value**: `'gemma2:2b'`.

9. **host**
  - **Description**: Ollama host address.
  - **Required**: Yes.
  - **Default Value**: `'http://127.0.0.1:11434'`.

10. **PROMPT_GENRE**
  - **Description**: The genre of the prompt to generate.
  - **Default Value**: `' '` (space).

11. **reviewers_prompt**
  - **Description**: Ollama system prompt.
  - **Required**: No.
  - **Default Value**: `""` (empty string).

12. **ai_token**
  - **Description**: AI token.
  - **Required**: No.
  - **Default Value**: `" "` (space).

13. **include_files**
  - **Description**: A comma-separated list of files to include in the review.
  - **Required**: No.
  - **Default Value**: `" "` (defaults to empty, meaning no restrictions).

14. **exclude_files**
  - **Description**: A comma-separated list of files to exclude from the review.
  - **Required**: No.
  - **Default Value**: `" "` (defaults to empty, meaning no files passed).

