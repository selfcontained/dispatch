import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  DEFAULT_USER_AVATAR,
  USER_AVATAR_PRESETS,
  type UserAvatar,
} from "@dispatch/shared";
import { Button } from "@/components/ui/button";
import { useSaveUserAvatar, useUserAvatarQuery } from "@/hooks/use-user-avatar";
import { avatarLabel, UserAvatarGraphic } from "./user-avatar";
import { prepareAvatarPhoto } from "./prepare-avatar";
import { AvatarCropDialog } from "./avatar-crop-dialog";
import { RowButton } from "@/components/ui/row-button";

export function UserAvatarSettings() {
  const query = useUserAvatarQuery();
  const save = useSaveUserAvatar();
  const [preparing, setPreparing] = useState(false);
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const avatar = query.data?.avatar ?? DEFAULT_USER_AVATAR;
  const busy = preparing || save.isPending;
  const disabled = busy || !query.isSuccess;

  const choose = (next: UserAvatar) => {
    setError(null);
    save.mutate(next);
  };
  const upload = async (file: File) => {
    setError(null);
    save.reset();
    setPreparing(true);
    try {
      setPhoto(await prepareAvatarPhoto(file));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save this photo."
      );
    } finally {
      setPreparing(false);
    }
  };

  return (
    <section className="p-4 md:p-6" aria-labelledby="user-avatar-heading">
      {photo && (
        <AvatarCropDialog
          photo={photo}
          onRestoreFocus={() => uploadButton.current?.focus()}
          onClose={() => setPhoto(null)}
          onSave={async (dataUrl) => {
            await save.mutateAsync({ kind: "image", dataUrl });
          }}
        />
      )}
      <h2 id="user-avatar-heading" className="mb-1.5 section-label">
        Your avatar
      </h2>
      <p className="mb-4 max-w-2xl text-body-md text-muted-foreground">
        Make your messages easier to spot. This avatar is shared across browsers
        and devices connected to this Dispatch instance.
      </p>
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
            PNG, JPEG, WebP or HEIC/HEIF, up to 50 MB and 64 megapixels. Choose
            your framing; we’ll handle cropping and resizing.
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
            : save.isPending
              ? "Saving avatar…"
              : save.isSuccess
                ? "Avatar saved"
                : query.isPending
                  ? "Loading avatar…"
                  : ""}
        </span>
      </div>
      {query.isError && (
        <p role="alert" className="mt-2 text-body-md text-danger">
          Could not load your avatar.{" "}
          <Button
            variant="link"
            size="inline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </p>
      )}
      {(error || save.error) && (
        <p role="alert" className="mt-2 text-body-md text-danger">
          {error ?? save.error?.message}
        </p>
      )}
    </section>
  );
}
