import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";

type Locale = "en" | "zh";
type Translations = Record<string, string>;

const en: Translations = {
	// Header
	"header.title": "Matrix",
	"header.connected": "Connected",
	"header.disconnected": "Disconnected",
	"header.logout": "Logout",

	// Projects
	"project.add": "Add",
	"project.adding": "Adding…",
	"project.cancel": "Cancel",
	"project.pathPlaceholder": "Project path…",
	"project.noProjects": "No projects",
	"project.remove": "Remove project",
	"project.addProject": "Add project",
	"project.settings": "Project settings",
	"project.pathMissing": "Project directory not found",
	"project.newPathPlaceholder": "New project path…",
	"project.relocate": "Relocate",
	"project.relocating": "Relocating…",

	// Theme
	"theme.selector": "Theme",
	"theme.dark": "Dark",
	"theme.light": "Light",
	"theme.cuteLight": "Cute Light",
	"theme.cuteDark": "Cute Dark",

	// Language
	"lang.selector": "Language",
	"lang.en": "English",
	"lang.zh": "Chinese",

	// Sidebar / Tasks
	"tasks.title": "Tasks",
	"tasks.filter": "Filter tasks…",
	"tasks.noTasks": "No tasks yet",
	"tasks.sendMessage": "Send a message to get started",
	"tasks.noMatch": "No tasks match",
	"tasks.addTask": "Add task",
	"tasks.refresh": "Refresh",
	"tasks.clearFilter": "Clear filter",

	"tasks.moveToRoot": "↑ Move to root level",
	"tasks.hideCompleted": "Hide completed",

	// Orchestrator
	"orch.label": "Orchestrator",
	"orch.rootSession": "Root agent session",
	"orch.provider": "Provider",
	"orch.model": "Model",
	"orch.tasks": "Tasks",
	"orch.done": "Done",
	"orch.passed": "Passed",
	"orch.active": "Active",
	"orch.failed": "Failed",
	"orch.totalCost": "Total Cost",
	"orch.turns": "Turns",
	"orch.input": "Input",
	"orch.cacheWrite": "Cache Write",
	"orch.cacheRead": "Cache Read",
	"orch.output": "Output",
	"orch.pause": "Interrupt",

	// Status
	"status.draft": "Draft",
	"status.pending": "Pending",
	"status.in_progress": "In Progress",
	"status.verify": "Verify",
	"status.failed": "Failed",
	"status.closed": "Closed",

	// Task Detail
	"detail.title": "Task Details",
	"detail.details": "Details",
	"detail.status": "Status",
	"detail.color": "Color",
	"detail.branch": "Branch",
	"detail.worktree": "Worktree",
	"detail.updated": "Updated",
	"detail.elapsed": "Elapsed",
	"detail.waiting": "Waiting",
	"detail.age": "Age",
	"detail.cost": "Cost",
	"detail.commits": "Commits",
	"detail.delete": "Delete",
	"detail.budget": "budget",
	"detail.selectTask": "Select a task to view details",
	"detail.editDescription": "Edit description",
	"detail.clickToEdit": "Click to edit",
	"detail.runningHint": "Task is running — send a message to update it",
	"detail.noDescription": "No description",
	"detail.stop": "Stop",
	"detail.copyId": "Copy task ID",
	"detail.copied": "Copied!",
	"detail.clearSession": "Clear Session",
	"detail.collapse": "Collapse panel",
	"detail.expand": "Expand panel",

	// Activity
	"activity.title": "Activity",
	"activity.searchLogs": "Search logs…",
	"activity.noMatch": "No matching entries",
	"activity.noEvents": "No events yet",
	"activity.follow": "Follow",
	"activity.fullscreen": "Fullscreen",
	"activity.exitFullscreen": "Exit fullscreen",

	// Settings
	"settings.title": "Settings",
	"settings.titleGlobal": "Global Settings",
	"settings.titleProject": "Project Settings",
	"settings.titleLocal": "Local Settings",
	"settings.rootAuth": "Root Auth",
	"settings.rootModel": "Root Model",
	"settings.rootModelPlaceholder":
		"e.g. gpt-4o, claude-opus-4-6 (leave empty for default)",
	"settings.childAuth": "Child Auth",
	"settings.childModel": "Child Model",
	"settings.taskAgentModel": "Task Agent Model",
	"settings.taskAgentModelPlaceholder":
		"Model for child agents (leave empty to use root model)",
	"settings.authGroupNone": "— None —",
	"settings.inheritOption": "— Inherit —",
	"settings.useRootAuth": "Use Root Auth",
	"settings.useRootModel": "Use Root Model",
	"settings.budget": "Default Budget (USD)",
	"settings.clarifyTimeout": "Clarify Timeout (ms)",
	"settings.maxDepth": "Max Depth",
	"settings.default": "Default",
	"settings.unlimited": "Unlimited",
	"settings.noTimeout": "No timeout",
	"settings.maxDepthDefault": "3 (default)",
	"settings.selfBootstrap": "Self-Bootstrap Mode",
	"settings.restartDaemonHint": "Restart the daemon process",
	"settings.restartDaemon": "Restart Daemon",
	"settings.loading": "Loading…",
	"settings.inherit": "Inherit from lower layer",
	"settings.layerGlobal": "Global",
	"settings.layerRepo": "Repo",
	"settings.layerLocal": "Local",
	"settings.fromGlobal": "from: global",
	"settings.fromRepo": "from: repo",
	"settings.fromLocal": "from: local",
	"settings.sectionModels": "Models & Auth",
	"settings.sectionLimits": "Limits",
	"settings.sectionDaemon": "Daemon",
	"settings.defaultAuth": "Root Auth",
	"settings.authGroups": "Auth Groups (Global)",
	"settings.addAuthGroup": "Add auth group",
	"settings.authName": "Name",
	"settings.authProvider": "Provider",
	"settings.anthropicApiKey": "Anthropic API Key",
	"settings.claudeOauthToken": "Claude OAuth Token",
	"settings.openaiApiKey": "OpenAI API Key",
	"settings.openaiAccessToken": "OpenAI Access Token",
	"settings.openaiRefreshToken": "OpenAI Refresh Token",
	"settings.openaiAccountId": "OpenAI Account ID",
	"settings.openaiBaseUrl": "OpenAI Base URL",
	"settings.optionalFallback": "Optional fallback",
	"settings.authGroupName": "auth group name",
	"settings.port": "Port",
	"settings.sessionKeep": "Session Keep",
	"settings.save": "Save",
	"settings.revert": "Revert",
	"settings.cancel": "Cancel",
	"settings.delete": "Delete",
	"settings.tabGlobal": "Global",
	"settings.tabProject": "Project",
	"settings.tabLocal": "Local",
	"settings.mcpServers": "MCP Servers",
	"settings.addMcpServer": "Add MCP server",
	"settings.mcpServerName": "Server name",
	"settings.mcpServerCommand": "Command",
	"settings.mcpServerArgs": "Args (space-separated)",
	"settings.mcpServerEnv": "Env vars (KEY=VALUE, one per line)",
	"settings.inherited": "inherited",
	"settings.dangerZone": "Danger Zone",
	"settings.clearAllSessions": "Clear All Sessions",
	"settings.clearAllSessionsDescription":
		"Delete all session JSONL files for this project. All agents will start fresh.",
	"settings.removeProject": "Remove Project",
	"settings.removeProjectDescription":
		"Remove this project from Matrix. This does not delete any files on disk.",

	// Footer
	"footer.sendMessage": "Send a message…",
	"footer.messageToTask": 'Message to "{task}"…',
	"footer.send": "Send",
	"footer.attachImage": "Attach image",
	"footer.contextWindow": "Context",
	"footer.estimated": "estimated",
	"footer.compact": "Compact context",
	"footer.compactPending": "Compact pending…",

	// Clarifications
	"clarify.needed": "Clarification needed",
	"clarify.from": "from:",
	"clarify.placeholder": "Type your answer…",
	"clarify.answer": "Answer",

	// Pending messages
	"pending.label": "Pending:",

	// Message target
	"target.sendingTo": "Sending to:",
	"target.sendToOrch": "Send to orchestrator instead",

	// Confirmations
	"confirm.clearSessions":
		"Clear ALL session history for every task? This cannot be undone.",
	"confirm.clearRootSession":
		"Clear the orchestrator session? It will start fresh next time.",
	"confirm.clearTaskSession":
		'Clear session for "{title}"? The task will start fresh next time.',
	"confirm.deleteTask": 'Delete task "{title}"?',
	"confirm.removeProject": 'Remove project "{name}"?',

	// Compact boundary
	"compact.notVisible": "↑ Content above is not visible to the agent",
	"compact.collapse": "▼ Collapse",
	"compact.checkpoint": "▶ Checkpoint",

	// Log
	"log.youArrow": "You →",

	// Lifecycle
	"lifecycle.cleared": "Session history cleared",
	"lifecycle.deleted": "Deleted:",
	"lifecycle.taskStarted": "↳ Started:",
	"lifecycle.instructions": "Instructions:",
	"lifecycle.taskPassed": "✓ Passed:",
	"lifecycle.taskFailed": "✗ Failed:",

	// Task prompt
	"prompt.taskTitle": "Task title:",
	"prompt.taskDescription": "Description:",

	// MCP tool result labels
	"log.createdTask": "Created task:",
	"log.deletedTask": "Deleted task:",
	"log.closedTask": "Closed task:",
	"log.resetTask": "Reset task:",
	"log.reorderedTasks": "Reordered tasks",
	"log.listedProjects": "Listed projects",
	"log.messageSentToProject": "Message sent to project",
	"log.executingTasks": "Executing",
	"log.taskDone": "Done:",
	"log.treeCount": "{count} tasks",
	"log.treeEmpty": "Empty tree",
	"log.treeUpdated": "Task tree updated",
	"log.statusUpdate": "Status → {status}:",
	"log.messageSent": "Message sent",
	"log.reportSent": "Reported to parent",
	"log.clarifyAsked": "Question sent",
	"log.yieldWaiting": "Waiting for messages",
	"log.yieldReceived": "Received messages",
	"log.tasks": "tasks",

	// Tool names (MCP)
	"tools.mcp__mxd__get_tree": "Get Tree",
	"tools.mcp__mxd__get_task": "Get Task",
	"tools.mcp__mxd__create_task": "Create Task",
	"tools.mcp__mxd__update_task": "Update Task",
	"tools.mcp__mxd__execute_tasks": "Execute Tasks",
	"tools.mcp__mxd__yield": "yield",
	"tools.mcp__mxd__send_message": "Send Message",
	"tools.mcp__mxd__delete_task": "Delete Task",
	"tools.mcp__mxd__clarify": "Ask Clarification",
	"tools.mcp__mxd__done": "Done",

	// Tool card labels
	"tool.showMore": "Show more",
	"tool.showLess": "Show less",
	"tool.args": "Args",
	"tool.result": "Result",
	"tool.waiting": "Waiting for messages…",
	"tool.passed": "Passed",
	"tool.failed": "Failed",

	// Tool names (built-in)
	"tools.bash": "Shell",
	"tools.read_file": "Read File",
	"tools.write_file": "Write File",
	"tools.edit_file": "Edit File",
	"tools.list_files": "List Files",
	"tools.search": "Search",
};

const zh: Translations = {
	// Header
	"header.title": "Matrix",
	"header.connected": "已连接",
	"header.disconnected": "未连接",
	"header.logout": "登出",

	// Projects
	"project.add": "添加",
	"project.adding": "添加中…",
	"project.cancel": "取消",
	"project.pathPlaceholder": "项目路径…",
	"project.noProjects": "暂无项目",
	"project.remove": "移除项目",
	"project.addProject": "添加项目",
	"project.settings": "项目设置",
	"project.pathMissing": "项目目录未找到",
	"project.newPathPlaceholder": "新项目路径…",
	"project.relocate": "迁移",
	"project.relocating": "迁移中…",

	// Theme
	"theme.selector": "主题",
	"theme.dark": "深色",
	"theme.light": "浅色",
	"theme.cuteLight": "可爱浅色",
	"theme.cuteDark": "可爱深色",

	// Language
	"lang.selector": "语言",
	"lang.en": "英语",
	"lang.zh": "中文",

	// Sidebar / Tasks
	"tasks.title": "任务",
	"tasks.filter": "筛选任务…",
	"tasks.noTasks": "暂无任务",
	"tasks.sendMessage": "发送消息以开始",
	"tasks.noMatch": "没有匹配的任务",
	"tasks.addTask": "添加任务",
	"tasks.refresh": "刷新",
	"tasks.clearFilter": "清除筛选",

	"tasks.moveToRoot": "↑ 移至顶层",
	"tasks.hideCompleted": "隐藏已完成",

	// Orchestrator
	"orch.label": "编排器",
	"orch.rootSession": "根代理会话",
	"orch.provider": "提供者",
	"orch.model": "模型",
	"orch.tasks": "任务数",
	"orch.done": "完成",
	"orch.passed": "通过",
	"orch.active": "运行中",
	"orch.failed": "失败",
	"orch.totalCost": "总费用",
	"orch.turns": "轮次",
	"orch.input": "输入",
	"orch.cacheWrite": "缓存写入",
	"orch.cacheRead": "缓存读取",
	"orch.output": "输出",
	"orch.pause": "中断",

	// Status
	"status.draft": "草稿",
	"status.pending": "等待中",
	"status.in_progress": "进行中",
	"status.verify": "待验证",
	"status.failed": "失败",
	"status.closed": "已关闭",

	// Task Detail
	"detail.title": "任务详情",
	"detail.details": "详情",
	"detail.status": "状态",
	"detail.color": "颜色",
	"detail.branch": "分支",
	"detail.worktree": "工作树",
	"detail.updated": "更新时间",
	"detail.elapsed": "已用时",
	"detail.waiting": "等待中",
	"detail.age": "时长",
	"detail.cost": "费用",
	"detail.commits": "提交",
	"detail.delete": "删除",
	"detail.budget": "预算",
	"detail.selectTask": "选择一个任务查看详情",
	"detail.editDescription": "编辑描述",
	"detail.clickToEdit": "点击编辑",
	"detail.runningHint": "任务正在运行 — 发送消息来更新",
	"detail.noDescription": "暂无描述",
	"detail.stop": "停止",
	"detail.copyId": "复制任务ID",
	"detail.copied": "已复制！",
	"detail.clearSession": "清除会话",
	"detail.collapse": "折叠面板",
	"detail.expand": "展开面板",

	// Activity
	"activity.title": "活动",
	"activity.searchLogs": "搜索日志…",
	"activity.noMatch": "没有匹配的条目",
	"activity.noEvents": "暂无事件",
	"activity.follow": "跟踪",
	"activity.fullscreen": "全屏",
	"activity.exitFullscreen": "退出全屏",

	// Settings
	"settings.title": "设置",
	"settings.titleGlobal": "全局设置",
	"settings.titleProject": "项目设置",
	"settings.titleLocal": "本地设置",
	"settings.rootAuth": "根认证",
	"settings.rootModel": "根模型",
	"settings.rootModelPlaceholder": "如 gpt-4o, claude-opus-4-6（留空使用默认）",
	"settings.childAuth": "子代理认证",
	"settings.childModel": "子代理模型",
	"settings.taskAgentModel": "任务代理模型",
	"settings.taskAgentModelPlaceholder": "子代理使用的模型（留空使用根模型）",
	"settings.authGroupNone": "— 无 —",
	"settings.inheritOption": "— 继承 —",
	"settings.useRootAuth": "使用根认证",
	"settings.useRootModel": "使用根模型",
	"settings.budget": "默认预算 (USD)",
	"settings.clarifyTimeout": "澄清超时 (ms)",
	"settings.maxDepth": "最大深度",
	"settings.default": "默认",
	"settings.unlimited": "无限制",
	"settings.noTimeout": "无超时",
	"settings.maxDepthDefault": "3（默认）",
	"settings.selfBootstrap": "自引导模式",
	"settings.restartDaemonHint": "重启守护进程",
	"settings.restartDaemon": "重启守护进程",
	"settings.loading": "加载中…",
	"settings.inherit": "继承下层配置",
	"settings.layerGlobal": "全局",
	"settings.layerRepo": "仓库",
	"settings.layerLocal": "本地",
	"settings.fromGlobal": "来源: 全局",
	"settings.fromRepo": "来源: 仓库",
	"settings.fromLocal": "来源: 本地",
	"settings.sectionModels": "模型与认证",
	"settings.sectionLimits": "限制",
	"settings.sectionDaemon": "守护进程",
	"settings.defaultAuth": "根认证",
	"settings.authGroups": "认证组（全局）",
	"settings.addAuthGroup": "添加认证组",
	"settings.authName": "名称",
	"settings.authProvider": "提供商",
	"settings.anthropicApiKey": "Anthropic API 密钥",
	"settings.claudeOauthToken": "Claude OAuth 令牌",
	"settings.openaiApiKey": "OpenAI API 密钥",
	"settings.openaiAccessToken": "OpenAI Access Token",
	"settings.openaiRefreshToken": "OpenAI Refresh Token",
	"settings.openaiAccountId": "OpenAI Account ID",
	"settings.openaiBaseUrl": "OpenAI 基础 URL",
	"settings.optionalFallback": "可选备用",
	"settings.authGroupName": "认证组名称",
	"settings.port": "端口",
	"settings.sessionKeep": "保留会话数",
	"settings.save": "保存",
	"settings.revert": "还原",
	"settings.cancel": "取消",
	"settings.delete": "删除",
	"settings.tabGlobal": "全局",
	"settings.tabProject": "项目",
	"settings.tabLocal": "本地",
	"settings.mcpServers": "MCP 服务器",
	"settings.addMcpServer": "添加 MCP 服务器",
	"settings.mcpServerName": "服务器名称",
	"settings.mcpServerCommand": "命令",
	"settings.mcpServerArgs": "参数（空格分隔）",
	"settings.mcpServerEnv": "环境变量（每行 KEY=VALUE）",
	"settings.inherited": "继承",
	"settings.dangerZone": "危险操作",
	"settings.clearAllSessions": "清除所有会话",
	"settings.clearAllSessionsDescription":
		"删除此项目的所有会话 JSONL 文件。所有代理将重新开始。",
	"settings.removeProject": "移除项目",
	"settings.removeProjectDescription":
		"从 Matrix 中移除此项目。这不会删除磁盘上的任何文件。",

	// Footer
	"footer.sendMessage": "发送消息…",
	"footer.messageToTask": '发送消息给 "{task}"…',
	"footer.send": "发送",
	"footer.attachImage": "附加图片",
	"footer.contextWindow": "上下文",
	"footer.estimated": "估算",
	"footer.compact": "压缩上下文",
	"footer.compactPending": "压缩等待中…",

	// Clarifications
	"clarify.needed": "需要澄清",
	"clarify.from": "来自：",
	"clarify.placeholder": "输入你的回答…",
	"clarify.answer": "回答",

	// Pending messages
	"pending.label": "待处理：",

	// Message target
	"target.sendingTo": "发送至：",
	"target.sendToOrch": "改为发送给编排器",

	// Confirmations
	"confirm.clearSessions": "清除所有任务的会话历史？此操作不可撤销。",
	"confirm.clearRootSession": "清除编排器会话？编排器下次将重新开始。",
	"confirm.clearTaskSession": '清除 "{title}" 的会话？任务下次将重新开始。',
	"confirm.deleteTask": '删除任务 "{title}"？',
	"confirm.removeProject": '移除项目 "{name}"？',

	// Compact boundary
	"compact.notVisible": "↑ 以上内容对代理不可见",
	"compact.collapse": "▼ 折叠",
	"compact.checkpoint": "▶ 检查点",

	// Log
	"log.youArrow": "你 →",

	// Lifecycle
	"lifecycle.cleared": "会话历史已清除",
	"lifecycle.deleted": "已删除：",
	"lifecycle.taskStarted": "↳ 已启动：",
	"lifecycle.instructions": "指令：",
	"lifecycle.taskPassed": "✓ 通过：",
	"lifecycle.taskFailed": "✗ 失败：",

	// Task prompt
	"prompt.taskTitle": "任务标题：",
	"prompt.taskDescription": "描述：",

	// MCP tool result labels
	"log.createdTask": "创建了任务：",
	"log.deletedTask": "删除了任务：",
	"log.closedTask": "关闭了任务：",
	"log.resetTask": "重置了任务：",
	"log.reorderedTasks": "重新排列了任务",
	"log.listedProjects": "列出了项目",
	"log.messageSentToProject": "消息已发送到项目",
	"log.executingTasks": "正在执行",
	"log.taskDone": "完成：",
	"log.treeCount": "{count} 个任务",
	"log.treeEmpty": "空任务树",
	"log.treeUpdated": "任务树已更新",
	"log.statusUpdate": "状态 → {status}：",
	"log.messageSent": "消息已发送",
	"log.reportSent": "已上报父任务",
	"log.clarifyAsked": "问题已发送",
	"log.yieldWaiting": "等待消息中",
	"log.yieldReceived": "收到消息",
	"log.tasks": "个任务",

	// Tool names (MCP)
	"tools.mcp__mxd__get_tree": "查看任务树",
	"tools.mcp__mxd__get_task": "查看任务",
	"tools.mcp__mxd__create_task": "创建任务",
	"tools.mcp__mxd__update_task": "更新任务",
	"tools.mcp__mxd__execute_tasks": "执行任务",
	"tools.mcp__mxd__yield": "yield",
	"tools.mcp__mxd__send_message": "发送消息",
	"tools.mcp__mxd__delete_task": "删除任务",
	"tools.mcp__mxd__clarify": "请求澄清",
	"tools.mcp__mxd__done": "完成",

	// Tool card labels
	"tool.showMore": "展开",
	"tool.showLess": "收起",
	"tool.args": "参数",
	"tool.result": "结果",
	"tool.waiting": "等待消息中…",
	"tool.passed": "通过",
	"tool.failed": "失败",

	// Tool names (built-in)
	"tools.bash": "命令行",
	"tools.read_file": "读取文件",
	"tools.write_file": "写入文件",
	"tools.edit_file": "编辑文件",
	"tools.list_files": "列出文件",
	"tools.search": "搜索",
};

const translations: Record<Locale, Translations> = { en, zh };

function getDefaultLocale(): Locale {
	try {
		const stored = localStorage.getItem("mxd-locale");
		if (stored === "en" || stored === "zh") return stored;
		return navigator.language.startsWith("zh") ? "zh" : "en";
	} catch {
		return "en";
	}
}

type TFunction = (key: string, params?: Record<string, string>) => string;

interface LocaleContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: TFunction;
}

const LocaleContext = createContext<LocaleContextValue>({
	locale: "en",
	setLocale: () => {},
	t: (key) => key,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(getDefaultLocale);

	const setLocale = useCallback((l: Locale) => {
		setLocaleState(l);
		try {
			localStorage.setItem("mxd-locale", l);
		} catch {
			// ignore storage errors
		}
	}, []);

	const t: TFunction = useCallback(
		(key: string, params?: Record<string, string>) => {
			let value = translations[locale]?.[key] ?? translations.en[key] ?? key;
			if (params) {
				for (const [k, v] of Object.entries(params)) {
					value = value.replace(`{${k}}`, v);
				}
			}
			return value;
		},
		[locale],
	);

	return createElement(
		LocaleContext.Provider,
		{ value: { locale, setLocale, t } },
		children,
	);
}

export function useLocale(): LocaleContextValue {
	return useContext(LocaleContext);
}
