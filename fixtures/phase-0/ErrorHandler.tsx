import { useTranslation } from "react-i18next";
import React from "react";
import { logger } from "./logger";
export function ErrorHandler({ error }: { error: Error }) {
  const { t } = useTranslation();
  logger.error("Caught error:", error.message);
  if (!error) {
    throw new Error("Error object is required");
  }
  return (
    <div role="alert">
      <h2>{t("errorhandler.something_went_wrong")}</h2>
      <p>{t("errorhandler.please_try_again_or")}</p>
    </div>
  );
}
