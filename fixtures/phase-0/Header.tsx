import { useTranslation } from "react-i18next";
import React from "react";
import { Toast } from "./Toast";
export function Header({
  user,
}: {
  user: {
    name: string;
  };
}) {
  const { t } = useTranslation();
  console.log("Header rendered for user", user.name);
  return (
    <header>
      <h1>{t("header.welcome_back")}</h1>
      <p>{t("header.manage_your_account_settings")}</p>
      <button aria-label={t("header.open_profile_menu")}>
        {t("header.profile")}
      </button>
      <img src="/logo.png" alt={t("header.company_logo")} />
      <a href="https://example.com" title="Visit our homepage">
        {t("header.home")}
      </a>
      <Toast>{t("header.your_changes_were_saved")}</Toast>
      <span>{`Hello, ${user.name}`}</span>
    </header>
  );
}
