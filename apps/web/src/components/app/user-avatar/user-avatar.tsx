import { useState } from "react";
import { Cat, Coffee, Leaf, Mountain, Sun, UserRound } from "lucide-react";
import {
  type UserAvatar as AvatarValue,
  type UserAvatarPreset,
} from "@dispatch/shared";
import { cn } from "@/lib/utils";
import { useUserAvatar } from "./avatar-context";

const PRESETS = {
  person: {
    label: "Person",
    icon: UserRound,
    background: "#f4d792",
    color: "#332613",
  },
  sun: { label: "Sun", icon: Sun, background: "#fed7aa", color: "#7c2d12" },
  cat: { label: "Cat", icon: Cat, background: "#e9d5ff", color: "#581c87" },
  leaf: { label: "Leaf", icon: Leaf, background: "#bbf7d0", color: "#14532d" },
  mountain: {
    label: "Mountain",
    icon: Mountain,
    background: "#bfdbfe",
    color: "#1e3a8a",
  },
  coffee: {
    label: "Coffee",
    icon: Coffee,
    background: "#fecdd3",
    color: "#881337",
  },
};
export function avatarLabel(id: UserAvatarPreset): string {
  return PRESETS[id].label;
}

export function UserAvatarGraphic({
  avatar,
  className,
  label = "You",
  testId,
}: {
  avatar: AvatarValue;
  className?: string;
  label?: string;
  testId?: string;
}) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const preset = PRESETS[avatar.kind === "builtin" ? avatar.id : "person"];
  const Icon = preset.icon;
  const image =
    avatar.kind === "image" && avatar.dataUrl !== failedImage
      ? avatar.dataUrl
      : null;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-foreground/20",
        className
      )}
      style={{ backgroundColor: preset.background, color: preset.color }}
    >
      {image ? (
        <img
          src={image}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedImage(image)}
        />
      ) : (
        <Icon className="h-[56%] w-[56%]" aria-hidden="true" />
      )}
    </span>
  );
}

export function UserAvatar({
  className,
  testId = "chat-avatar-user",
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <UserAvatarGraphic
      avatar={useUserAvatar()}
      className={className}
      testId={testId}
    />
  );
}
