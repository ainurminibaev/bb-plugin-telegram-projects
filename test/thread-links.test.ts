import test from "node:test";
import assert from "node:assert/strict";
import {cleanAssistantText} from "../telegram-ux";

test("С102: a line of nothing but thread links goes away; no «рабочая сессия» tail",()=>{
  const out=cleanAssistantText("Готово: встреча поставлена на четверг.\n\n@thread:thr_ab12cd34ef");
  assert.equal(out,"Готово: встреча поставлена на четверг.");
  assert.equal(cleanAssistantText("Сделал.\nТред: @thread:thr_ab12cd34ef#msg=12, @thread:thr_zz99yy88xx"),"Сделал.");
  assert.equal(cleanAssistantText("Итог:\n- @thread:thr_ab12cd34ef\n- @thread:thr_zz99yy88xx\nВсё."),"Итог:\nВсё.");
  assert.doesNotMatch(cleanAssistantText("Ок.\nсм. @thread:thr_ab12cd34ef"),/сессия|thr_|см\./);
});

test("С102: a thread link inside a sentence leaves a readable phrase",()=>{
  assert.equal(cleanAssistantText("Подробный разбор лежит в @thread:thr_ab12cd34ef, итог ниже."),"Подробный разбор лежит в рабочем треде, итог ниже.");
  assert.equal(cleanAssistantText("Результат пришёл из thr_ab12cd34ef вчера."),"Результат пришёл вчера.");
  assert.equal(cleanAssistantText("Сверил цифры (см. @thread:thr_ab12cd34ef) — расхождений нет."),"Сверил цифры — расхождений нет.");
  // Shorter rather than a wrong case: the preposition goes away with the link.
  assert.equal(cleanAssistantText("Передал задачу в подтред @thread:thr_ab12cd34ef и жду итог."),"Передал задачу и жду итог.");
  assert.equal(cleanAssistantText("Передал задачу в @thread:thr_ab12cd34ef , итог ниже"),"Передал задачу, итог ниже");
  assert.equal(cleanAssistantText("Ответ @thread:thr_ab12cd34ef будет завтра."),"Ответ будет завтра.");
  assert.doesNotMatch(cleanAssistantText("Отправил в thr_ab12cd34ef задачу."),/рабоч/);
  assert.equal(cleanAssistantText("@thread:thr_ab12cd34ef — итог: всё перевёл."),"итог: всё перевёл.","no dash left hanging");
  assert.equal(cleanAssistantText("План — по шагам."),"План — по шагам.","a dash of an ordinary line stays");
  for (const s of ["Подробный разбор лежит в @thread:thr_ab12cd34ef, итог ниже.","Ответ @thread:thr_ab12cd34ef будет завтра."])
    assert.doesNotMatch(cleanAssistantText(s),/thr_|@thread|сессия|\s,|\s{2}/);
});
