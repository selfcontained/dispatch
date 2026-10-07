import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserAvatar } from "@dispatch/shared";
import { api } from "@/lib/api";

const KEY = ["user-avatar"] as const;
const ENDPOINT = "/api/v1/app/settings/user-avatar";
type Response = { avatar: UserAvatar };

export function useUserAvatarQuery() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<Response>(ENDPOINT),
    staleTime: 30_000,
  });
}

export function useSaveUserAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (avatar: UserAvatar) =>
      api<Response>(ENDPOINT, {
        method: "PUT",
        body: JSON.stringify({ avatar }),
      }),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });
}
