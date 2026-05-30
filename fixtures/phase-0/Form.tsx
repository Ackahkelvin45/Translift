import { useTranslation } from "react-i18next";
import React from "react";
import { toast } from "react-hot-toast";
export function ContactForm() {
  const { t } = useTranslation();
  const handleSubmit = () => {
    toast(t("contactform.message_sent_successfully"));
  };
  return (
    <form>
      <input type="text" placeholder={t("contactform.your_name")} />
      <input type="email" placeholder={t("contactform.youexamplecom")} />
      <textarea placeholder={t("contactform.type_your_message_here")} />
      <button type="submit">{t("contactform.send")}</button>
    </form>
  );
}
