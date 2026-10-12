import { FC } from "react";
import { RiHeart3Fill } from "react-icons/ri";
import { useTranslation } from "react-i18next";
import { useSnapshot } from "valtio";
import Inspector from "./components";
import { InputCheckbox } from "./components/input";

const Inspector_Fansly: FC = () => {
  const { t } = useTranslation();
  const data = useSnapshot(window.ApiServer.state.services.fansly.data);
  return <Inspector.Body>
    <Inspector.Header><RiHeart3Fill /> {t("fansly.title")}</Inspector.Header>
    <Inspector.Content>
      <InputCheckbox label="common.field_enable" value={data.enable} onChange={e => window.ApiServer.patchService("fansly", s => s.data.enable = e)} />
    </Inspector.Content>
  </Inspector.Body>
}

export default Inspector_Fansly;
