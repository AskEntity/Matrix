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
	"header.title": "OpenGraft",
	"header.connected": "Connected",
	"header.disconnected": "Disconnected",

	// Projects
	"project.add": "Add",
	"project.cancel": "Cancel",
	"project.pathPlaceholder": "Project path…",
	"project.noProjects": "No projects",
	"project.remove": "Remove project",
	"project.addProject": "Add project",
	"project.settings": "Project settings",

	// Theme
	"theme.lightMode": "Switch to light mode",
	"theme.darkMode": "Switch to dark mode",

	// Language
	"lang.toggle": "Switch language",

	// Sidebar / Tasks
	"tasks.title": "Tasks",
	"tasks.filter": "Filter tasks…",
	"tasks.noTasks": "No tasks yet",
	"tasks.startAgent": "Start an agent to create tasks",
	"tasks.noMatch": "No tasks match",
	"tasks.addTask": "Add task",
	"tasks.refresh": "Refresh",
	"tasks.clearFilter": "Clear filter",

	// Orchestrator
	"orch.label": "Orchestrator",
	"orch.rootSession": "Root agent session",
	"orch.state": "State",
	"orch.provider": "Provider",
	"orch.model": "Model",
	"orch.tasks": "Tasks",
	"orch.done": "Done",
	"orch.passed": "Passed",
	"orch.active": "Active",
	"orch.failed": "Failed",
	"orch.session": "Session",
	"orch.totalCost": "Total Cost",
	"orch.turns": "Turns",
	"orch.input": "Input",
	"orch.cacheWrite": "Cache Write",
	"orch.cacheRead": "Cache Read",
	"orch.output": "Output",
	"orch.clearSessions": "Clear Sessions",

	// Status
	"status.running": "Running",
	"status.idle": "Idle",
	"status.pending": "Pending",
	"status.in_progress": "In Progress",
	"status.testing": "Testing",
	"status.passed": "Passed",
	"status.failed": "Failed",
	"status.stuck": "Stuck",

	// Task Detail
	"detail.title": "Task Details",
	"detail.details": "Details",
	"detail.status": "Status",
	"detail.branch": "Branch",
	"detail.worktree": "Worktree",
	"detail.updated": "Updated",
	"detail.running": "Running",
	"detail.waiting": "Waiting",
	"detail.age": "Age",
	"detail.cost": "Cost",
	"detail.message": "Message",
	"detail.commits": "Commits",
	"detail.continue": "Continue",
	"detail.history": "History",
	"detail.delete": "Delete",
	"detail.budget": "budget",
	"detail.retryPlaceholder": "Instructions for retry…",
	"detail.selectTask": "Select a task to view details",
	"detail.loadingHistory": "Loading history…",
	"detail.noHistory": "No conversation history found.",

	// Activity
	"activity.title": "Activity",
	"activity.searchLogs": "Search logs…",
	"activity.noMatch": "No matching entries",
	"activity.noEvents": "No events yet",
	"activity.follow": "Follow",

	// Settings
	"settings.title": "Project Settings",
	"settings.model": "Model",
	"settings.childModel": "Child Model",
	"settings.budget": "Default Budget (USD)",
	"settings.clarifyTimeout": "Clarify Timeout (ms)",
	"settings.maxDepth": "Max Depth",
	"settings.default": "Default",
	"settings.unlimited": "Unlimited",
	"settings.noTimeout": "No timeout",
	"settings.maxDepthDefault": "3 (default)",
	"settings.restartHint": "Restart to apply config changes",
	"settings.restartAgent": "Restart Agent",

	// Footer
	"footer.describeBuild": "Describe what to build…",
	"footer.sendMessage": "Send a message to the agent…",
	"footer.messageToTask": 'Message to "{task}"…',
	"footer.send": "Send",
	"footer.stop": "Stop",
	"footer.run": "Run",

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
		"Clear session history? The orchestrator will start fresh next time.",
	"confirm.deleteTask": 'Delete task "{title}"?',
	"confirm.removeProject": 'Remove project "{name}"?',

	// Conversation roles
	"conv.user": "USER",
	"conv.assistant": "ASSISTANT",

	// Compact boundary
	"compact.notVisible": "↑ Content above is not visible to the agent",
	"compact.collapse": "▼ Collapse",
	"compact.checkpoint": "▶ Checkpoint",

	// Log
	"log.youArrow": "You →",

	// Lifecycle
	"lifecycle.started": "Orchestration started",
	"lifecycle.stopped": "Agent stopped",
	"lifecycle.cleared": "Session history cleared",
	"lifecycle.deleted": "Deleted:",
	"lifecycle.continued": "↳ Continued:",
	"lifecycle.taskStarted": "↳ Started:",
	"lifecycle.instructions": "Instructions:",
	"lifecycle.taskPassed": "✓ Passed:",
	"lifecycle.taskFailed": "✗ Failed:",

	// Task prompt
	"prompt.taskTitle": "Task title:",
	"prompt.taskDescription": "Description:",

	// Model options
	"model.sonnet": "Sonnet",
	"model.opus": "Opus",
	"model.haiku": "Haiku",

	// Cute theme
	"theme.cuteMode": "Toggle cute mode",
	"theme.cuteOn": "Cute mode on",
	"theme.cuteOff": "Cute mode off",
};

const zh: Translations = {
	// Header
	"header.title": "OpenGraft",
	"header.connected": "已连接",
	"header.disconnected": "未连接",

	// Projects
	"project.add": "添加",
	"project.cancel": "取消",
	"project.pathPlaceholder": "项目路径…",
	"project.noProjects": "暂无项目",
	"project.remove": "移除项目",
	"project.addProject": "添加项目",
	"project.settings": "项目设置",

	// Theme
	"theme.lightMode": "切换到亮色模式",
	"theme.darkMode": "切换到暗色模式",

	// Language
	"lang.toggle": "切换语言",

	// Sidebar / Tasks
	"tasks.title": "任务",
	"tasks.filter": "筛选任务…",
	"tasks.noTasks": "暂无任务",
	"tasks.startAgent": "启动代理以创建任务",
	"tasks.noMatch": "没有匹配的任务",
	"tasks.addTask": "添加任务",
	"tasks.refresh": "刷新",
	"tasks.clearFilter": "清除筛选",

	// Orchestrator
	"orch.label": "编排器",
	"orch.rootSession": "根代理会话",
	"orch.state": "状态",
	"orch.provider": "提供者",
	"orch.model": "模型",
	"orch.tasks": "任务数",
	"orch.done": "完成",
	"orch.passed": "通过",
	"orch.active": "运行中",
	"orch.failed": "失败",
	"orch.session": "会话",
	"orch.totalCost": "总费用",
	"orch.turns": "轮次",
	"orch.input": "输入",
	"orch.cacheWrite": "缓存写入",
	"orch.cacheRead": "缓存读取",
	"orch.output": "输出",
	"orch.clearSessions": "清除会话",

	// Status
	"status.running": "运行中",
	"status.idle": "空闲",
	"status.pending": "等待中",
	"status.in_progress": "进行中",
	"status.testing": "测试中",
	"status.passed": "通过",
	"status.failed": "失败",
	"status.stuck": "卡住",

	// Task Detail
	"detail.title": "任务详情",
	"detail.details": "详情",
	"detail.status": "状态",
	"detail.branch": "分支",
	"detail.worktree": "工作树",
	"detail.updated": "更新时间",
	"detail.running": "运行中",
	"detail.waiting": "等待中",
	"detail.age": "时长",
	"detail.cost": "费用",
	"detail.message": "消息",
	"detail.commits": "提交",
	"detail.continue": "继续",
	"detail.history": "历史",
	"detail.delete": "删除",
	"detail.budget": "预算",
	"detail.retryPlaceholder": "重试说明…",
	"detail.selectTask": "选择一个任务查看详情",
	"detail.loadingHistory": "加载历史…",
	"detail.noHistory": "未找到对话历史。",

	// Activity
	"activity.title": "活动",
	"activity.searchLogs": "搜索日志…",
	"activity.noMatch": "没有匹配的条目",
	"activity.noEvents": "暂无事件",
	"activity.follow": "跟踪",

	// Settings
	"settings.title": "项目设置",
	"settings.model": "模型",
	"settings.childModel": "子模型",
	"settings.budget": "默认预算 (USD)",
	"settings.clarifyTimeout": "澄清超时 (ms)",
	"settings.maxDepth": "最大深度",
	"settings.default": "默认",
	"settings.unlimited": "无限制",
	"settings.noTimeout": "无超时",
	"settings.maxDepthDefault": "3（默认）",
	"settings.restartHint": "重启以应用配置更改",
	"settings.restartAgent": "重启代理",

	// Footer
	"footer.describeBuild": "描述你要构建的内容…",
	"footer.sendMessage": "向代理发送消息…",
	"footer.messageToTask": '发送消息给 "{task}"…',
	"footer.send": "发送",
	"footer.stop": "停止",
	"footer.run": "运行",

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
	"confirm.clearSessions": "清除会话历史？编排器下次将重新开始。",
	"confirm.deleteTask": '删除任务 "{title}"？',
	"confirm.removeProject": '移除项目 "{name}"？',

	// Conversation roles
	"conv.user": "用户",
	"conv.assistant": "助手",

	// Compact boundary
	"compact.notVisible": "↑ 以上内容对代理不可见",
	"compact.collapse": "▼ 折叠",
	"compact.checkpoint": "▶ 检查点",

	// Log
	"log.youArrow": "你 →",

	// Lifecycle
	"lifecycle.started": "编排已启动",
	"lifecycle.stopped": "代理已停止",
	"lifecycle.cleared": "会话历史已清除",
	"lifecycle.deleted": "已删除：",
	"lifecycle.continued": "↳ 已继续：",
	"lifecycle.taskStarted": "↳ 已启动：",
	"lifecycle.instructions": "指令：",
	"lifecycle.taskPassed": "✓ 通过：",
	"lifecycle.taskFailed": "✗ 失败：",

	// Task prompt
	"prompt.taskTitle": "任务标题：",
	"prompt.taskDescription": "描述：",

	// Model options
	"model.sonnet": "Sonnet",
	"model.opus": "Opus",
	"model.haiku": "Haiku",

	// Cute theme
	"theme.cuteMode": "切换可爱模式",
	"theme.cuteOn": "可爱模式已开启",
	"theme.cuteOff": "可爱模式已关闭",
};

const translations: Record<Locale, Translations> = { en, zh };

function getDefaultLocale(): Locale {
	try {
		const stored = localStorage.getItem("og-locale");
		if (stored === "en" || stored === "zh") return stored;
		return navigator.language.startsWith("zh") ? "zh" : "en";
	} catch {
		return "en";
	}
}

export type TFunction = (
	key: string,
	params?: Record<string, string>,
) => string;

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
			localStorage.setItem("og-locale", l);
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
