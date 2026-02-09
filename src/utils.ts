import http from "http";
import https from "https";

export function split_message(files: string): string[] {
  files = files || "";
  let n = files.includes('\n') || files.includes('\r');
  files = files.trim()
  let res: string[] = [];
  if (files) {
    if (n) {
      res = files.split(/[\r\n]/);
    } else {
      res = files.split(",")
    }
  }
  return res.map(str => str.trim()).filter(item => item !== null && item !== undefined && item !== "")
}

export function doesAnyPatternMatch(patterns: Array<string>, str: string) {
  // 遍历正则表达式数组
  return patterns.some(pattern => {
    // 创建正则表达式对象，匹配模式
    const regex = new RegExp(pattern);
    // 测试字符串是否与正则表达式匹配
    return regex.test(str);
  });
}

/**
 * post data
 * @param url url
 * @param body post data
 * @param header post header
 * @param json is json res
 */
export async function post({url, body, header, json}: any): Promise<string> {
  return new Promise((resolve, reject) => {
    json = typeof json === "boolean" ? json : true;
    const data = typeof body === "string" ? body : JSON.stringify(body);
    let url_ = new URL(url);
    header = header || {};
    header['Content-Type'] = header['Content-Type'] || 'application/json';
    header['Content-Length'] = Buffer.byteLength(data)
    const options = {
      hostname: url_.hostname, // 确保去掉协议部分
      port: url_.port || (url_.protocol === "http:" ? 80 : 443),
      path: url_.pathname + (url_.search || ''),
      method: 'POST',
      headers: header
    };

    console.log(`[DEBUG] Sending POST request to: ${url}`);

    // noinspection DuplicatedCode
    const req = (url_.protocol === "http:" ? http : https).request(options, (res) => {
      console.log(`[DEBUG] Response received. Status Code: ${res.statusCode}`);
      let responseBody = '';

      // 根据 Content-Type 头获取字符编码
      const contentType = res.headers['content-type'];
      let charset: BufferEncoding = 'utf-8'; // 默认字符编码

      // 解析 Content-Type 以获取编码，如果有指定编码
      if (contentType) {
        const match = contentType.match(/charset=([\w-]+)/i);
        if (match) {
          if (match[1].toLowerCase() === 'utf-8') {
            charset = 'utf-8';
          } else if (match[1].toLowerCase() === 'gbk') {
            charset = 'ascii';
          } else if (match[1].toLowerCase() === 'ascii') {
            charset = 'ascii';
          } else {
            charset = 'utf-8'; // 默认字符编码
          }
        }
      }
      res.setEncoding(charset);

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Request failed with status ${res.statusCode}: ${responseBody}`));
          return;
        }

        try {
          if (json) {
            if (!responseBody.trim()) {
              reject(new Error('Received empty response body'));
              return;
            }
            resolve(JSON.parse(responseBody));
          } else {
            resolve(responseBody);
          }
        } catch (error: any) {
          reject(new Error('Failed to parse : \'' + responseBody + '\'' + ' with error: ' + error.message));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.write(data);
    req.end();
  });
}

export async function get(url: string, headers: any): Promise<any> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, {headers}, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', (e) => reject(e));
  });
}

export function parseAIReviewResponse(aiResponse: string): {
  body: string,
  comments: Array<{ path: string, line: number, start_line?: number, body: string }>
} {
  // --- 1. 预处理 ---

  // 1.1 移除 <think>...</think> 思考过程
  let cleanResponse = aiResponse.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 1.2 移除末尾的 LGTM 标记
  // 解释：匹配 (换行 或 字符串开头) + 空格 + LGTM + 空格 + 字符串结尾
  // 这样无论 LGTM 是单独一行，还是紧接在 Summary 后面，都会被剔除
  cleanResponse = cleanResponse.replace(/(^|\n)\s*LGTM\s*$/i, "").trim();

  // --- 2. 分割逻辑 ---
  // 修改分割逻辑，不仅支持 ^---$ 这种严格匹配，也支持前后有空格的情况
  const parts = cleanResponse.split(/^-{3,}\s*$/gm);

  let mainBody = "";
  const lineComments: Array<{ path: string, line: number, start_line?: number, body: string }> = [];

  for (const part of parts) {
    const block = part.trim();
    if (!block) continue;

    // --- 3. 特征检测 ---
    // 检查是否包含必要的字段，即使字段前面有微小的差异（如 "File:" vs "文件:"）
    const hasFile = /^(?:File|文件|FilePath)\s*[:：]/im.test(block);
    const hasComment = /^(?:Comment|Review|评论|注释|反馈)\s*[:：]/im.test(block);

    if (hasFile && hasComment) {
      // === 解析 Issue Block ===
      const filePathMatch = block.match(/^(?:File|文件|FilePath)\s*[:：]\s*(.*)$/im);
      const startLineMatch = block.match(/^(?:StartLine|Start\s*Line|起始行号|开始行号|Start)\s*[:：]\s*(\d+)$/im);
      const endLineMatch = block.match(/^(?:(?:End)?Line|End\s*Line|结束行号|终止行号|End)\s*[:：]\s*(\d+)$/im);
      const commentBodyMatch = block.match(/^(?:Comment|Review|评论|注释|反馈)\s*[:：]\s*([\s\S]*)$/im);

      if (filePathMatch && endLineMatch && commentBodyMatch) {
        const endLine = parseInt(endLineMatch[1], 10);
        const startLine = startLineMatch ? parseInt(startLineMatch[1], 10) : endLine;

        lineComments.push({
          path: filePathMatch[1].trim(),
          line: endLine,
          start_line: startLine !== endLine ? startLine : undefined,
          body: commentBodyMatch[1].trim()
        });
      }
    } else {
      // === 解析 Summary ===
      // 因为前面已经全局移除了 LGTM，这里不再需要特殊判断 block === "LGTM"

      if (!block.startsWith("File:")) {
        if (mainBody) mainBody += "\n\n" + block;
        else mainBody = block;
      }
    }
  }

  return {body: mainBody.trim(), comments: lineComments};
}
