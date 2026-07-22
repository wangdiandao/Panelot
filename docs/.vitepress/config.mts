import { defineConfig } from 'vitepress';
import type { DefaultTheme } from 'vitepress';

const githubUrl = 'https://github.com/wangdiandao/Panelot';

const chineseTheme: DefaultTheme.Config = {
  nav: [
    { text: '首页', link: '/' },
    { text: '使用文档', link: '/guide/' },
    { text: '开发文档', link: '/development/' },
    { text: '隐私政策', link: '/privacy/' },
    { text: 'GitHub', link: githubUrl },
  ],
  sidebar: {
    '/guide/': [
      {
        text: '用户指南',
        items: [
          { text: '文档总览', link: '/guide/' },
          { text: '安装与首次配置', link: '/guide/getting-started' },
          { text: '对话与上下文', link: '/guide/chats-and-context' },
          { text: '浏览器操作与权限', link: '/guide/browser-and-permissions' },
          { text: 'Provider 与模型', link: '/guide/providers-and-models' },
          { text: 'Skills、Plugins 与 MCP', link: '/guide/skills-plugins-mcp' },
          { text: '数据与隐私', link: '/guide/data-and-privacy' },
          { text: '常见问题', link: '/guide/troubleshooting' },
        ],
      },
    ],
    '/development/': [
      {
        text: '开发文档',
        items: [
          { text: '开发文档总览', link: '/development/' },
          { text: '架构与消息协议', link: '/development/architecture' },
          { text: '数据模型与存储', link: '/development/data-model' },
          { text: 'Provider', link: '/development/providers' },
          { text: 'Agent 引擎', link: '/development/agent-engine' },
          { text: '浏览器工具', link: '/development/browser-tools' },
          { text: '权限与安全', link: '/development/permissions' },
          { text: '远端 MCP', link: '/development/mcp' },
          { text: 'Skills 与 Plugins', link: '/development/skills-plugins' },
          { text: '界面', link: '/development/ui' },
          { text: '提示词', link: '/development/prompts' },
          { text: '参考项目', link: '/development/references' },
          { text: '体验目标', link: '/development/experience-targets' },
        ],
      },
    ],
    '/privacy/': [
      {
        text: '隐私',
        items: [{ text: '隐私政策', link: '/privacy/' }],
      },
    ],
  },
  search: {
    provider: 'local',
    options: {
      translations: {
        button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
        modal: {
          noResultsText: '没有找到相关结果',
          resetButtonTitle: '清除搜索条件',
          footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
        },
      },
    },
  },
  outline: { level: [2, 3], label: '本页目录' },
  socialLinks: [{ icon: 'github', link: githubUrl }],
  editLink: {
    pattern: `${githubUrl}/edit/main/docs/:path`,
    text: '在 GitHub 上编辑此页',
  },
  lastUpdated: {
    text: '最后更新',
    formatOptions: { dateStyle: 'medium', timeStyle: 'short' },
  },
  docFooter: { prev: '上一篇', next: '下一篇' },
  returnToTopLabel: '返回顶部',
  sidebarMenuLabel: '文档导航',
  skipToContentLabel: '跳到正文',
  darkModeSwitchLabel: '外观',
  lightModeSwitchTitle: '切换到浅色模式',
  darkModeSwitchTitle: '切换到深色模式',
  langMenuLabel: '语言',
  externalLinkIcon: true,
  footer: {
    message: '文档随 Panelot 源码一同更新。中文文档是内容基准。',
    copyright: 'Copyright © 2026 Panelot contributors',
  },
};

const englishTheme: DefaultTheme.Config = {
  nav: [
    { text: 'Home', link: '/en/' },
    { text: 'User guide', link: '/en/guide/' },
    { text: 'Development', link: '/en/development/' },
    { text: 'Privacy', link: '/en/privacy/' },
    { text: 'GitHub', link: githubUrl },
  ],
  sidebar: {
    '/en/guide/': [
      {
        text: 'User guide',
        items: [
          { text: 'Overview', link: '/en/guide/' },
          { text: 'Install and configure', link: '/en/guide/getting-started' },
          { text: 'Chats and context', link: '/en/guide/chats-and-context' },
          { text: 'Browser actions and permissions', link: '/en/guide/browser-and-permissions' },
          { text: 'Providers and models', link: '/en/guide/providers-and-models' },
          { text: 'Skills, Plugins, and MCP', link: '/en/guide/skills-plugins-mcp' },
          { text: 'Data and privacy', link: '/en/guide/data-and-privacy' },
          { text: 'Troubleshooting', link: '/en/guide/troubleshooting' },
        ],
      },
    ],
    '/en/development/': [
      {
        text: 'Development',
        items: [
          { text: 'Overview', link: '/en/development/' },
          { text: 'Architecture and protocol', link: '/en/development/architecture' },
          { text: 'Data model and storage', link: '/en/development/data-model' },
          { text: 'Providers', link: '/en/development/providers' },
          { text: 'Agent engine', link: '/en/development/agent-engine' },
          { text: 'Browser tools', link: '/en/development/browser-tools' },
          { text: 'Permissions and security', link: '/en/development/permissions' },
          { text: 'Remote MCP', link: '/en/development/mcp' },
          { text: 'Skills and Plugins', link: '/en/development/skills-plugins' },
          { text: 'UI', link: '/en/development/ui' },
          { text: 'Prompts', link: '/en/development/prompts' },
          { text: 'References', link: '/en/development/references' },
          { text: 'Experience targets', link: '/en/development/experience-targets' },
        ],
      },
    ],
    '/en/privacy/': [
      {
        text: 'Privacy',
        items: [{ text: 'Privacy policy', link: '/en/privacy/' }],
      },
    ],
  },
  search: { provider: 'local' },
  outline: { level: [2, 3], label: 'On this page' },
  socialLinks: [{ icon: 'github', link: githubUrl }],
  editLink: {
    pattern: `${githubUrl}/edit/main/docs/:path`,
    text: 'Edit this page on GitHub',
  },
  lastUpdated: {
    text: 'Last updated',
    formatOptions: { dateStyle: 'medium', timeStyle: 'short' },
  },
  docFooter: { prev: 'Previous', next: 'Next' },
  returnToTopLabel: 'Return to top',
  sidebarMenuLabel: 'Documentation navigation',
  skipToContentLabel: 'Skip to content',
  darkModeSwitchLabel: 'Appearance',
  lightModeSwitchTitle: 'Switch to light theme',
  darkModeSwitchTitle: 'Switch to dark theme',
  langMenuLabel: 'Language',
  externalLinkIcon: true,
  footer: {
    message: 'The documentation is maintained with the Panelot source. Chinese is authoritative.',
    copyright: 'Copyright © 2026 Panelot contributors',
  },
};

export default defineConfig({
  base: '/Panelot/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://wangdiandao.github.io/Panelot/' },
  head: [
    ['meta', { name: 'theme-color', content: '#5b5bd6' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Panelot 文档',
      description: 'Panelot 浏览器 Agent 扩展的使用、开发与隐私文档',
      themeConfig: chineseTheme,
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Panelot documentation',
      description: 'User, development, and privacy documentation for the Panelot browser agent',
      themeConfig: englishTheme,
    },
  },
});
