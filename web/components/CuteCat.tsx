import { useEffect, useRef, useState } from "react";

export function CuteCat() {
	const [isTyping, setIsTyping] = useState(false);
	const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const handleKeyDown = () => {
			setIsTyping(true);
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
			typingTimeout.current = setTimeout(() => setIsTyping(false), 500);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
		};
	}, []);

	return (
		<div className={`og-cute-cat${isTyping ? " og-cat-typing" : ""}`}>
			<svg
				viewBox="0 0 100 120"
				width="90"
				height="108"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				role="img"
				aria-label="Cute cat"
			>
				<title>Cute cat</title>
				{/* Tail */}
				<path
					className="og-cat-tail"
					d="M78 95 C88 85, 95 70, 88 58"
					stroke="#ffb6c1"
					strokeWidth="3.5"
					strokeLinecap="round"
					fill="none"
				/>
				{/* Body */}
				<ellipse cx="50" cy="100" rx="24" ry="18" fill="#ffb6c1" />
				{/* Left ear outer */}
				<polygon points="22,52 14,28 38,46" fill="#ffb6c1" />
				{/* Right ear outer */}
				<polygon points="78,52 86,28 62,46" fill="#ffb6c1" />
				{/* Left ear inner */}
				<polygon points="24,50 18,34 35,47" fill="#ff8fab" />
				{/* Right ear inner */}
				<polygon points="76,50 82,34 65,47" fill="#ff8fab" />
				{/* Head */}
				<ellipse cx="50" cy="60" rx="28" ry="24" fill="#ffb6c1" />
				{/* Eyes */}
				<ellipse
					className="og-cat-eye og-cat-eye-l"
					cx="39"
					cy="58"
					rx="3"
					ry="3.5"
					fill="#4a2030"
				/>
				<ellipse
					className="og-cat-eye og-cat-eye-r"
					cx="61"
					cy="58"
					rx="3"
					ry="3.5"
					fill="#4a2030"
				/>
				{/* Nose */}
				<polygon points="50,65 47.5,62 52.5,62" fill="#ff6b9d" />
				{/* Mouth */}
				<path
					d="M50 65 Q46 70 43 68"
					stroke="#ff6b9d"
					strokeWidth="1.2"
					strokeLinecap="round"
					fill="none"
				/>
				<path
					d="M50 65 Q54 70 57 68"
					stroke="#ff6b9d"
					strokeWidth="1.2"
					strokeLinecap="round"
					fill="none"
				/>
				{/* Whiskers — left side */}
				<line
					className="og-cat-whisker"
					x1="35"
					y1="63"
					x2="8"
					y2="58"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<line
					className="og-cat-whisker"
					x1="35"
					y1="65"
					x2="7"
					y2="65"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<line
					className="og-cat-whisker"
					x1="35"
					y1="67"
					x2="8"
					y2="72"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				{/* Whiskers — right side */}
				<line
					className="og-cat-whisker"
					x1="65"
					y1="63"
					x2="92"
					y2="58"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<line
					className="og-cat-whisker"
					x1="65"
					y1="65"
					x2="93"
					y2="65"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<line
					className="og-cat-whisker"
					x1="65"
					y1="67"
					x2="92"
					y2="72"
					stroke="#d48a9e"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				{/* Left paw */}
				<ellipse
					className="og-cat-paw og-cat-paw-l"
					cx="36"
					cy="114"
					rx="7"
					ry="5"
					fill="#ffc0cb"
				/>
				{/* Right paw */}
				<ellipse
					className="og-cat-paw og-cat-paw-r"
					cx="64"
					cy="114"
					rx="7"
					ry="5"
					fill="#ffc0cb"
				/>
			</svg>
		</div>
	);
}
