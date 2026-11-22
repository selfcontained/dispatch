import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  DEFAULT_USER_AVATAR,
  USER_AVATAR_PRESETS,
  type UserAvatar,
} from "@dispatch/shared";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { useSaveUserAvatar, useUserAvatarQuery } from "@/hooks/use-user-avatar";
import { avatarLabel, UserAvatarGraphic } from "./user-avatar";
import { prepareAvatarPhoto } from "./prepare-avatar";
import { AvatarCropDialog } from "./avatar-crop-dialog";
import { Alert } from "@/components/ui/alert";
import { SettingsGroup } from "@/components/app/settings-layout";
import { SettingRow } from "@/components/ui/setting-row";
import { useAutoSave } from "@/hooks/use-auto-save";
import { LoadError } from "@/components/ui/async-boundary";

export function UserAvatarSettings() {
  const query = useUserAvatarQuery();
  const save = useSaveUserAvatar();
  const [preparing, setPreparing] = useState(false);
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<unknown>();
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const autoSave = useAutoSave<UserAvatar, "avatar">((_, next) =>
    save.mutateAsync(next)
  );
  const avatar = autoSave.value(
    "avatar",
    query.data?.avatar ?? DEFAULT_USER_AVATAR
  );
  const disabled = preparing || !query.isSuccess;

  const choose = (next: UserAvatar) => {
    setError(undefined);
    void autoSave.save("avatar", next);
  };
  const upload = async (file: File) => {
    setError(undefined);
    setPreparing(true);
    try {
      setPhoto(await prepareAvatarPhoto(file));
    } catch (err) {
      setError(err);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <SettingsGroup title="Profile">
      {photo && (
        <AvatarCropDialog
          photo={photo}
          onRestoreFocus={() => uploadButton.current?.focus()}
          onClose={() => setPhoto(null)}
          onSave={async (dataUrl) => {
            const result = await autoSave.save("avatar", {
              kind: "image",
              dataUrl,
            });
            // The crop stays open with the reason.
            if (!result.ok) throw result.error;
          }}
        />
      )}
      <SettingRow
        layout="group"
        label="Your avatar"
        description="Makes your messages easier to spot, on every browser and device connected to this instance."
        status={autoSave.status("avatar")}
      >
        <div className="flex items-center gap-4">
          <UserAvatarGraphic
            avatar={avatar}
            className="h-16 w-16"
            label="Current avatar"
            testId="user-avatar-preview"
          />
          <div>
            <Button
              ref={uploadButton}
              size="sm"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              <Upload />
              Upload photo
            </Button>
            <p className="mt-2 text-body-sm text-muted-foreground">
              PNG, JPEG, WebP or HEIC/HEIF, up to 50 MB and 64 megapixels.
              Choose your framing; we’ll handle cropping and resizing.
            </p>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
          className="hidden"
          aria-label="Upload avatar image"
          data-testid="user-avatar-upload"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        <div
          role="group"
          aria-label="Built-in avatars"
          className="mt-4 flex flex-wrap gap-2"
        >
          {USER_AVATAR_PRESETS.map((id) => (
            <RowButton
              key={id}
              selected={avatar.kind === "builtin" && avatar.id === id}
              className="w-auto flex-col gap-1.5 border border-transparent px-3 py-2 aria-pressed:border-primary"
              disabled={disabled}
              aria-pressed={avatar.kind === "builtin" && avatar.id === id}
              aria-label={`Use ${avatarLabel(id)} avatar`}
              onClick={() => choose({ kind: "builtin", id })}
            >
              <UserAvatarGraphic
                avatar={{ kind: "builtin", id }}
                className="h-10 w-10"
                label={avatarLabel(id)}
              />
              <span className="text-body-sm">{avatarLabel(id)}</span>
            </RowButton>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={
              disabled || (avatar.kind === "builtin" && avatar.id === "person")
            }
            onClick={() => choose(DEFAULT_USER_AVATAR)}
          >
            Reset avatar
          </Button>
          <span className="text-body-sm text-muted-foreground" role="status">
            {preparing
              ? "Preparing photo…"
              : query.isPending
                ? "Loading avatar…"
                : ""}
          </span>
        </div>
        {query.isError && (
          <LoadError
            thing="your avatar"
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
            className="mt-2"
          />
        )}
        {error ? (
          <Alert
            title="Couldn’t open the photo."
            error={error}
            className="mt-2"
          />
        ) : null}
      </SettingRow>
    </SettingsGroup>
  );
}
