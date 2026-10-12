import { ServiceNetworkState } from "@/types";
import { AnimatePresence, motion } from "framer-motion";
import { FC, PropsWithChildren } from "react";
import { SiTwitch } from "react-icons/si";
import { useSnapshot } from "valtio";
import Tooltip from "./dropdown/Tooltip";

const StatusButton: FC<PropsWithChildren<{animKey: string, tooltip: string, onClick: () => void}>> = ({animKey, tooltip, onClick, children}) => {
  return <motion.div
  key={animKey}
  initial={{ opacity: 0, scale:0 }}
  exit={{ opacity: 0, scale: 0 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ ease: "anticipate", duration: 0.5 }}
>
  <Tooltip content={tooltip} body={animKey}>
    <button onClick={onClick} className="btn btn-sm btn-warning btn-circle">
      {children}
    </button>
  </Tooltip>
</motion.div>
}

const RecordingAlerts: FC = () => {
  const { chatPostEnable, chatEnable, chatPostLive } = useSnapshot(
    window.ApiServer.state.services.twitch.data
  );
  const { liveStatus: twitchLiveStatus } = useSnapshot(window.ApiServer.twitch.state);
  const { connection: twitchChatStatus } = useSnapshot(window.ApiServer.twitch.chat.state);

  const handleStopTwitch = () => {
    window.ApiServer.patchService("twitch", state => state.data.chatPostEnable = false)
  };

  const showTwitch =
    chatEnable &&
    chatPostEnable &&
    twitchChatStatus === ServiceNetworkState.connected &&
    (chatPostLive ? twitchLiveStatus === ServiceNetworkState.connected : true);


  return (
    <div className="flex space-x-2">
      <AnimatePresence>
        {showTwitch && <StatusButton key="twitch" tooltip="Twitch Chat integration" animKey="twitch" onClick={handleStopTwitch }><SiTwitch size={20} /></StatusButton>}
      </AnimatePresence>
    </div>
  );
};

export default RecordingAlerts;
