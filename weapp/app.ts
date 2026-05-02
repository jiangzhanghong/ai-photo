import { getStoredUser } from "./utils/session";
import type { User } from "./types/api";

App<IAppOption>({
  globalData: {
    user: getStoredUser()
  }
});

interface IAppOption {
  globalData: {
    user: User | null;
  };
}
