import { useEffect, useState } from "react";
import { useLocale } from "../i18n.ts";

interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
	hasToolUse: boolean;
	toolNames?: string[];
}

export function ConversationHistory({
	projectId,
	nodeId,
}: {
	projectId: string;
	nodeId: string;
}) {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setLoading(true);
		fetch(`/projects/${projectId}/tasks/${nodeId}/conversation`)
			.then((r) => r.json())
			.then((data: { messages: ConversationMessage[] }) => {
				setMessages(data.messages ?? []);
			})
			.catch(() => setMessages([]))
			.finally(() => setLoading(false));
	}, [projectId, nodeId]);

	const { t } = useLocale();

	if (loading) {
		return (
			<div className="og-conv-history">
				<div className="og-conv-loading">{t("detail.loadingHistory")}</div>
			</div>
		);
	}

	if (messages.length === 0) {
		return (
			<div className="og-conv-history">
				<div className="og-conv-empty">{t("detail.noHistory")}</div>
			</div>
		);
	}

	return (
		<div className="og-conv-history">
			{messages.map((msg, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable index for static list
				<div key={i} className={`og-conv-msg og-conv-msg-${msg.role}`}>
					<span className={`og-conv-role-badge og-conv-role-${msg.role}`}>
						{msg.role === "user" ? t("conv.user") : t("conv.assistant")}
					</span>
					<div className="og-conv-content">{msg.content}</div>
					{msg.hasToolUse && msg.toolNames && msg.toolNames.length > 0 && (
						<div className="og-conv-tools">🔧 {msg.toolNames.join(", ")}</div>
					)}
				</div>
			))}
		</div>
	);
}
