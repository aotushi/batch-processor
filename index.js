import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import simpleGit from "simple-git";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BatchProcessor {
  constructor() {
    this.workspaceRoot = path.resolve(__dirname, "..");
    this.generatedSites = [];
  }

  async start() {
    console.log("🚀 批量站点生成与部署工具 (v4.0)\n");

    try {
      await this.checkDependencies();
      const answers = await this.getUserInput();
      await this.generateProjects(answers);
      await this.deployToGitHub();
      await this.writeSiteMappings();

      console.log(`\n✅ 所有 ${this.generatedSites.length} 个站点已成功生成并部署到GitHub!`);
    } catch (error) {
      console.error(`\n❌ 处理过程中出现严重错误: ${error.message}`);
      process.exit(1);
    }
  }

  async checkDependencies() {
    try {
      execSync("gh --version", { stdio: "ignore" });
    } catch (error) {
      throw new Error("GitHub CLI (`gh`) 未安装或未在系统PATH中. 请先安装: https://cli.github.com/");
    }

    try {
      execSync("gh auth status", { stdio: "pipe" });
    } catch (error) {
      throw new Error(
        "GitHub CLI 未登录或授权已过期. \n" +
          "请在终端中运行 `gh auth login`, 完成登录和授权后, 再重新运行此脚本。\n" +
          "原始错误信息: " +
          error.stderr.toString()
      );
    }
  }

  async getUserInput() {
    console.log("ℹ️ 工作目录说明:");
    console.log(`   - 脚本将以 'batch-processor' 的父目录作为工作区根目录.`);
    console.log(`   - 当前识别的工作区根目录是: ${this.workspaceRoot}`);
    console.log("   - 生成的新站点项目将放置在此目录下。\n");

    const questions = [
      {
        type: "input",
        name: "templateName",
        message: "请输入模板项目的文件夹名称 (例如: site31):",
        validate: (input) => {
          if (!input.trim()) return "名称不能为空.";
          if (!/site\d+$/.test(input)) return '模板文件夹名称必须以 "site" 和数字结尾 (例如: site31).';
          return true;
        },
      },
      {
        type: "number",
        name: "subdomainCount",
        message: "您希望为每个主域名生成多少个子域名?",
        default: 1,
        validate: (input) => (input >= 0 ? true : "数量必须大于等于0"),
      },
      {
        type: "number",
        name: "prefixLength",
        message: "请输入随机子域名前缀的长度:",
        default: 5,
        validate: (input) => (input >= 3 && input <= 10 ? true : "长度建议在3到10之间"),
        when: (answers) => answers.subdomainCount > 0,
      },
      {
        type: "number",
        name: "gamesMin",
        message: "每个 games.json 最小游戏数量:",
        default: 10,
        validate: (input) => (input >= 1 ? true : "最小数量必须大于等于1"),
      },
      {
        type: "number",
        name: "gamesMax",
        message: "每个 games.json 最大游戏数量:",
        default: 20,
        validate: (input, answers) => (input >= answers.gamesMin ? true : "最大数量不能小于最小数量"),
      },
    ];

    const answers = await inquirer.prompt(questions);

        // 动态搜索模板文件夹
    const foundPath = await this.findTemplatePath(this.workspaceRoot, answers.templateName);
    if (!foundPath) {
      throw new Error(`在工作区 ${this.workspaceRoot} 或其父目录中未找到名为 '${answers.templateName}' 的模板文件夹.`);
    }
    
    // 校验模板 games.json 数量
    const gamesJsonPath = path.join(foundPath, "data/games.json");
    const gamesData = await fs.readJson(gamesJsonPath);
    if (gamesData.length < answers.gamesMax) {
      throw new Error(`模板 games.json 数量不足 (共${gamesData.length}项), 不能满足最大需求 ${answers.gamesMax}`);
    }

    answers.templatePath = foundPath;
    await this.validateTemplateProject(foundPath);

    if (answers.subdomainCount === 0) {
      console.log("⚠️  将仅为每个主域名生成站点");
    } else {
      console.log("ℹ️  将为每个主域名及其子域名生成站点");
    }
    return answers;
  }

  async findTemplatePath(startDir, templateName) {
    let currentDir = startDir;
    // 限制向上搜索的层数，防止无限循环
    for (let i = 0; i < 5; i++) {
      const potentialPath = path.join(currentDir, templateName);
      if (await fs.pathExists(potentialPath)) {
        return potentialPath;
      }

      const parentDir = path.dirname(currentDir);
      // 如果到达根目录，则停止
      if (parentDir === currentDir) {
        // 最后再检查一下`startDir`的同级目录
        const siblingCheckDir = path.join(path.dirname(startDir), "wjspark"); // 特定检查wjspark
        const finalPath = path.join(siblingCheckDir, templateName);
        if (await fs.pathExists(finalPath)) {
          return finalPath;
        }
        return null;
      }
      currentDir = parentDir;
    }
    return null;
  }

  async validateTemplateProject(fullPath) {
    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`模板项目路径不存在: ${fullPath}`);
    }

    const requiredFiles = ["data/site-config.js", "data/games.json"];
    for (const file of requiredFiles) {
      if (!(await fs.pathExists(path.join(fullPath, file)))) {
        throw new Error(`模板项目缺少必要文件: ${file}`);
      }
    }
    console.log(`\n✅ 模板项目验证通过: ${fullPath}`);
  }

  generateRandomPrefix(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  extractSiteNumber(siteName) {
    const match = siteName.match(/(\d+)$/);
    if (!match) throw new Error(`无法从模板名称 "${siteName}" 中提取站点编号.`);
    return parseInt(match[1]);
  }

  async generateProjects({ templatePath, subdomainCount, prefixLength, gamesMin, gamesMax }) {
    const templateName = path.basename(templatePath);
    const baseNumber = this.extractSiteNumber(templateName);

    const totalSitesToCreate = config.domains.length * (1 + subdomainCount);
    console.log(`\n📁 根据模板 ${templateName}, 总计将创建 ${totalSitesToCreate} 个新站点...`);

    let siteNumberCounter = baseNumber;
    let siteIndex = 0;

    const allDomains = [];
    for (const mainDomain of config.domains) {
      // 主域名站点
      allDomains.push(mainDomain);
      // 子域名站点
      if (subdomainCount > 0) {
        for (let i = 0; i < subdomainCount; i++) {
          const prefix = this.generateRandomPrefix(prefixLength);
          allDomains.push(`${prefix}.${mainDomain}`);
        }
      }
    }

    // 生成区间内不重复的随机数量列表
    const possibleCounts = [];
    for (let i = gamesMin; i <= gamesMax; i++) possibleCounts.push(i);
    if (possibleCounts.length < totalSitesToCreate) {
      throw new Error(`games.json 区间数量 (${possibleCounts.length}) 小于项目数 (${totalSitesToCreate}), 请调整区间。`);
    }
    // 洗牌算法打乱
    for (let i = possibleCounts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [possibleCounts[i], possibleCounts[j]] = [possibleCounts[j], possibleCounts[i]];
    }

    for (const newDomain of allDomains) {
      siteNumberCounter++;
      const projectName = `site${siteNumberCounter}`;
      const projectPath = path.join(this.workspaceRoot, projectName);

      console.log(`  -> 正在创建项目: ${projectName}`);

      if (await fs.pathExists(projectPath)) {
        console.warn(`  ⚠️  警告: 项目文件夹 ${projectName} 已存在, 将跳过.`);
        continue;
      }

      console.log(`     分配域名: ${newDomain}`);

      // 复制时排除 .git 目录
      await fs.copy(templatePath, projectPath, {
        filter: (src) => {
          // 排除 .git 文件夹及其所有内容
          if (src.endsWith(`${path.sep}.git`) || src.includes(`${path.sep}.git${path.sep}`)) return false;
          return true;
        },
      });
      await this.updateSiteConfig(projectPath, projectName, newDomain);
      // 分配 games.json 数量
      const gamesCount = possibleCounts[siteIndex];
      await this.processGamesJson(projectPath, gamesCount);

      this.generatedSites.push({
        projectName,
        path: projectPath,
        domain: newDomain,
      });
      console.log(`  🎉 ${projectName} 生成完成.`);
      siteIndex++;
    }
  }

  async updateSiteConfig(projectPath, projectName, domain) {
    const configPath = path.join(projectPath, "data/site-config.js");
    let content = await fs.readFile(configPath, "utf-8");

    // 请注意: 这里我们保留了模板中的 logo, favicon, twitterCard, 和 ogImage 路径
    const newSiteObject = `const site = {
  "name": "${domain}",
  "title": "${config.siteTemplate.title}",
  "description": "${config.siteTemplate.description}",
  "logo": "/images/logo.png",
  "favicon": "/favicon.ico",
  "keywords": ${JSON.stringify(config.siteTemplate.keywords)},
  "author": "${domain} Team",
  "language": "${config.siteTemplate.language}",
  "url": "https://${domain}",
  "twitterCard": "/images/summary_large_image.png",
  "ogImage": "/images/og-image.png",
};`;

    // 使用正则表达式安全地替换原有的 site 对象
    content = content.replace(/const site = {[\s\S]*?};/, newSiteObject);

    await fs.writeFile(configPath, content, "utf-8");
  }

    async processGamesJson(projectPath, gamesCount) {
    const gamesPath = path.join(projectPath, "data/games.json");
    try {
      let gamesData = await fs.readJson(gamesPath);
      if (Array.isArray(gamesData.games)) {
        // 洗牌
        for (let i = gamesData.games.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [gamesData.games[i], gamesData.games[j]] = [gamesData.games[j], gamesData.games[i]];
        }
        gamesData.games = gamesData.games.slice(0, gamesCount);
      }
      await fs.writeJson(gamesPath, gamesData, { spaces: 2 });
    } catch (error) {
      console.warn(`  ⚠️  处理 ${path.basename(gamesPath)} 时出现警告: ${error.message}`);
    }
  }

  async deployToGitHub() {
    console.log("\n🚀 开始部署到GitHub...");

    if (config.githubUsername === "YourGitHubUsername" || !config.githubUsername) {
      throw new Error("请在 config.js 文件中正确设置您的 GitHub 用户名!");
    }

    for (const site of this.generatedSites) {
      console.log(`\n  -> 正在部署: ${site.projectName}`);
      try {
        const git = simpleGit(site.path);
        await git.init().add(".").commit("feat: Initial commit");

        // 清理所有 remote，防止遗留
        const remotes = await git.getRemotes(true);
        for (const remote of remotes) {
          await git.removeRemote(remote.name);
        }

        const repoName = `wj-${site.projectName}`;
        const fullRepoName = `${config.githubUsername}/${repoName}`;

        console.log(`     创建并推送至GitHub仓库: ${fullRepoName}`);

        execSync(`gh repo create ${fullRepoName} --source=. --push --private`, {
          cwd: site.path,
          stdio: "inherit",
        });

        console.log(`  🎉 ${site.projectName} 部署成功: https://github.com/${fullRepoName}`);
      } catch (error) {
        throw new Error(`部署 ${site.projectName} 失败. \n   原始错误: ${error.message}`);
      }
    }
  }

  async writeSiteMappings() {
    console.log("\n💾 正在保存站点与域名的映射关系...");
    const mapping = this.generatedSites.map((site) => ({
      siteName: site.projectName,
      domain: site.domain,
    }));

    const outputPath = path.join(__dirname, "generated-sites-map.json");
    await fs.writeJson(outputPath, mapping, { spaces: 2 });
    console.log(`  -> 映射关系已成功保存到: ${outputPath}`);
  }
}

const processor = new BatchProcessor();
processor.start();
